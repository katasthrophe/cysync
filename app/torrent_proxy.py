"""
Server-side torrent proxy: downloads torrents via standard BitTorrent protocol
(TCP/UDP/DHT — connects to ALL seeders: qBittorrent, Transmission, Deluge, etc.)
and serves them as HTTP streams to the browser.

This makes ALL torrents work, not just the rare ones with WebRTC seeders.
Falls back gracefully to browser-only WebTorrent if libtorrent is not installed.
"""
import asyncio
import os
import re
import time
import uuid
import shutil
import logging
from pathlib import Path
from typing import Dict, Optional
import tempfile

logger = logging.getLogger("cysync.torrent_proxy")

try:
    import libtorrent as lt
    HAS_LIBTORRENT = True
    _lt_version = getattr(lt, 'version', 'unknown')
    logger.info(f"✅ libtorrent {_lt_version} loaded — server-side torrent proxy enabled")
except ImportError:
    lt = None
    HAS_LIBTORRENT = False
    logger.info("⚠️ libtorrent not available — torrents will use browser-only WebTorrent (WebRTC only)")

DOWNLOAD_DIR = Path(tempfile.gettempdir()) / "cysync_torrents"
MAX_CONCURRENT = 3
METADATA_TIMEOUT = 45  # seconds to wait for torrent metadata
CLEANUP_AGE = 7200  # 2 hours: auto-delete old downloads
VIDEO_EXTENSIONS = {'.mp4', '.m4v', '.webm', '.mkv', '.avi', '.mov', '.ts', '.wmv', '.ogv', '.flv'}


class TorrentDownload:
    """Tracks a single server-side torrent download."""

    def __init__(self, download_id: str, handle, save_path: Path, name: str = "Torrent"):
        self.download_id = download_id
        self.handle = handle
        self.save_path = save_path
        self.name = name
        self.video_file_path: Optional[Path] = None
        self.video_file_index: int = 0
        self.total_size: int = 0
        self.has_metadata: bool = False
        self.is_streamable: bool = False
        self.error: Optional[str] = None
        self.created_at: float = time.time()


class TorrentProxy:
    """
    Manages server-side BitTorrent downloads and exposes files for HTTP streaming.
    Uses libtorrent to connect to ALL BitTorrent peers (not just WebRTC).
    """

    def __init__(self):
        self.downloads: Dict[str, TorrentDownload] = {}
        self.session = None

        if HAS_LIBTORRENT:
            self._init_session()

    @property
    def available(self) -> bool:
        """True if libtorrent is installed and the session is active."""
        return HAS_LIBTORRENT and self.session is not None

    def _init_session(self):
        """Initialize the libtorrent session with optimal settings."""
        try:
            # Create session
            self.session = lt.session()

            # Apply settings
            settings = self.session.get_settings()
            settings['listen_interfaces'] = '0.0.0.0:6881,[::]:6881'
            settings['enable_dht'] = True
            settings['enable_lsd'] = True
            settings['enable_natpmp'] = True
            settings['enable_upnp'] = True
            settings['anonymous_mode'] = False
            settings['connections_limit'] = 200
            settings['download_rate_limit'] = 0  # no limit

            # Prioritize head of file for streaming
            settings['auto_manage_startup'] = 2
            settings['auto_manage_interval'] = 5

            try:
                settings['alert_mask'] = (
                    int(lt.alert.category_t.error_notification) |
                    int(lt.alert.category_t.status_notification)
                )
            except Exception:
                pass  # Different API in some versions

            self.session.apply_settings(settings)

            # DHT bootstrap routers — essential for finding peers without trackers
            dht_routers = [
                ("router.bittorrent.com", 6881),
                ("router.utorrent.com", 6881),
                ("dht.transmissionbt.com", 6881),
                ("dht.aelitis.com", 6881),
            ]
            for host, port in dht_routers:
                try:
                    self.session.add_dht_router(host, port)
                except Exception:
                    pass

            DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
            logger.info("libtorrent session initialized successfully")

        except Exception as e:
            logger.error(f"Failed to initialize libtorrent session: {e}")
            self.session = None

    async def add_magnet(self, magnet_uri: str) -> Optional[str]:
        """
        Add a magnet link for server-side downloading.
        Returns a download_id on success, or None on failure.
        """
        if not self.available:
            return None

        # Enforce concurrent download limit
        active = [d for d in self.downloads.values() if not d.error]
        if len(active) >= MAX_CONCURRENT:
            oldest = min(active, key=lambda d: d.created_at)
            self.remove_download(oldest.download_id)
            logger.info(f"Removed oldest download {oldest.download_id} to make room")

        download_id = uuid.uuid4().hex[:12]
        save_path = DOWNLOAD_DIR / download_id
        save_path.mkdir(parents=True, exist_ok=True)

        # Extract torrent name from magnet for display
        dn_match = re.search(r'[&?]dn=([^&]+)', magnet_uri)
        display_name = "Torrent Stream"
        if dn_match:
            from urllib.parse import unquote_plus
            display_name = unquote_plus(dn_match.group(1))

        try:
            params = lt.parse_magnet_uri(magnet_uri)
            params.save_path = str(save_path)

            handle = self.session.add_torrent(params)
            handle.set_sequential_download(True)  # Download pieces in order for streaming

            dl = TorrentDownload(download_id, handle, save_path, name=display_name)
            self.downloads[download_id] = dl

            logger.info(f"Started torrent download {download_id}: {display_name}")
            return download_id

        except Exception as e:
            logger.error(f"Failed to add magnet: {e}")
            # Cleanup
            try:
                shutil.rmtree(save_path, ignore_errors=True)
            except Exception:
                pass
            return None

    async def wait_for_metadata(self, download_id: str, timeout: float = METADATA_TIMEOUT) -> bool:
        """
        Wait until torrent metadata is available (file list, sizes, etc.).
        Returns True if metadata arrived within the timeout.
        """
        dl = self.downloads.get(download_id)
        if not dl:
            return False

        start = time.time()
        while time.time() - start < timeout:
            try:
                status = dl.handle.status()
                if status.has_metadata:
                    self._process_metadata(dl)
                    return True
                # Check for critical errors
                if hasattr(status, 'errc') and status.errc.value() != 0:
                    dl.error = f"Torrent error: {status.errc.message()}"
                    logger.error(f"Torrent {download_id} error: {dl.error}")
                    return False
            except Exception as e:
                dl.error = str(e)
                return False
            await asyncio.sleep(0.5)

        dl.error = "Timeout: no metadata received. The torrent may have no active seeders."
        logger.warning(f"Torrent {download_id}: metadata timeout")
        return False

    def _process_metadata(self, dl: TorrentDownload):
        """Process torrent metadata: find the best video file and prioritize it."""
        try:
            tf = dl.handle.torrent_file()
            if not tf:
                return

            fs = tf.files()
            dl.name = tf.name() or dl.name
            dl.has_metadata = True

            # Find the best (largest) video file
            best_idx = -1
            best_size = 0

            for i in range(fs.num_files()):
                file_path = fs.file_path(i)
                ext = os.path.splitext(file_path)[1].lower()
                size = fs.file_size(i)
                if ext in VIDEO_EXTENSIONS and size > best_size:
                    best_idx = i
                    best_size = size

            # If no video extension found, use the largest file (might be a video anyway)
            if best_idx < 0:
                for i in range(fs.num_files()):
                    if fs.file_size(i) > best_size:
                        best_idx = i
                        best_size = fs.file_size(i)

            if best_idx < 0:
                best_idx = 0
                best_size = fs.file_size(0) if fs.num_files() > 0 else 0

            dl.video_file_index = best_idx
            dl.total_size = best_size
            dl.video_file_path = dl.save_path / fs.file_path(best_idx)

            # Set file priorities: max for our video, skip everything else
            for i in range(fs.num_files()):
                if i == best_idx:
                    dl.handle.file_priority(i, 7)  # Maximum priority
                else:
                    dl.handle.file_priority(i, 0)  # Don't download

            dl.is_streamable = True

            video_name = fs.file_path(best_idx)
            size_mb = best_size / (1024 * 1024)
            logger.info(f"Torrent {dl.download_id}: selected '{video_name}' ({size_mb:.1f} MB)")

        except Exception as e:
            logger.error(f"Error processing metadata for {dl.download_id}: {e}")
            dl.error = f"Metadata processing error: {e}"

    def get_download(self, download_id: str) -> Optional[TorrentDownload]:
        """Get a download by ID."""
        return self.downloads.get(download_id)

    def get_status(self, download_id: str) -> Optional[dict]:
        """Get detailed status of a download."""
        dl = self.downloads.get(download_id)
        if not dl:
            return None

        try:
            s = dl.handle.status()
            state_names = {
                0: "queued", 1: "checking_files", 2: "downloading_metadata",
                3: "downloading", 4: "finished", 5: "seeding",
                6: "allocating", 7: "checking_resume_data"
            }
            state_val = int(s.state)

            return {
                "download_id": download_id,
                "name": dl.name,
                "has_metadata": dl.has_metadata,
                "is_streamable": dl.is_streamable,
                "progress": round(s.progress * 100, 1),
                "download_rate": s.download_rate,
                "upload_rate": s.upload_rate,
                "num_peers": s.num_peers,
                "num_seeds": s.num_seeds,
                "state": state_names.get(state_val, str(s.state)),
                "total_size": dl.total_size,
                "total_size_mb": round(dl.total_size / (1024 * 1024), 1) if dl.total_size else 0,
                "error": dl.error,
            }
        except Exception as e:
            return {
                "download_id": download_id,
                "name": dl.name,
                "error": dl.error or str(e)
            }

    def get_file_path(self, download_id: str) -> Optional[Path]:
        """Get the path to the video file (may be partially downloaded)."""
        dl = self.downloads.get(download_id)
        if dl and dl.video_file_path:
            return dl.video_file_path
        return None

    def get_content_type(self, download_id: str) -> str:
        """Guess the MIME type of the video file."""
        dl = self.downloads.get(download_id)
        if not dl or not dl.video_file_path:
            return "application/octet-stream"

        ext = dl.video_file_path.suffix.lower()
        mime_map = {
            '.mp4': 'video/mp4',
            '.m4v': 'video/mp4',
            '.webm': 'video/webm',
            '.mkv': 'video/x-matroska',
            '.avi': 'video/x-msvideo',
            '.mov': 'video/quicktime',
            '.ts': 'video/mp2t',
            '.ogv': 'video/ogg',
            '.flv': 'video/x-flv',
            '.wmv': 'video/x-ms-wmv',
        }
        return mime_map.get(ext, 'video/mp4')

    def remove_download(self, download_id: str):
        """Remove a download and clean up its files."""
        dl = self.downloads.pop(download_id, None)
        if not dl:
            return

        try:
            if self.session:
                self.session.remove_torrent(dl.handle)
        except Exception:
            pass

        try:
            shutil.rmtree(dl.save_path, ignore_errors=True)
        except Exception:
            pass

        logger.info(f"Removed torrent download {download_id}")

    async def cleanup_old(self):
        """Remove downloads older than CLEANUP_AGE seconds."""
        now = time.time()
        to_remove = [
            did for did, dl in self.downloads.items()
            if now - dl.created_at > CLEANUP_AGE
        ]
        for did in to_remove:
            self.remove_download(did)
        if to_remove:
            logger.info(f"Cleaned up {len(to_remove)} old torrent downloads")


# ── Global singleton ──
torrent_proxy = TorrentProxy()
