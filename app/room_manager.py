import asyncio
import re
import time
import urllib.parse
from typing import Dict, List, Optional, Set
from fastapi import WebSocket
import httpx

try:
    import yt_dlp
except ImportError:
    yt_dlp = None

from app.models import MediaItem, PlaybackState, ChatMessage, UserInfo

# Import torrent proxy (graceful: works even if libtorrent not installed)
try:
    from app.torrent_proxy import torrent_proxy
except ImportError:
    torrent_proxy = None

def extract_youtube_id(url_or_id: str) -> Optional[str]:
    """
    Extracts 11-character YouTube video ID from any format.
    Supports youtu.be, youtube.com/watch?v=, shorts, embed, live, mobile, etc.
    """
    raw = url_or_id.strip()
    if len(raw) == 11 and re.match(r'^[a-zA-Z0-9_-]{11}$', raw):
        return raw

    if raw.startswith(('www.', 'youtube.', 'youtu.be', 'm.youtube.', 'music.youtube.')):
        raw = 'https://' + raw

    try:
        parsed = urllib.parse.urlparse(raw)
    except Exception:
        parsed = None

    if parsed and parsed.hostname:
        hostname = parsed.hostname.lower()

        if 'youtu.be' in hostname:
            path_parts = [p for p in parsed.path.strip('/').split('/') if p]
            if path_parts and len(path_parts[0]) == 11:
                return path_parts[0]

        if 'youtube.com' in hostname:
            qs = urllib.parse.parse_qs(parsed.query)
            if 'v' in qs and qs['v'] and len(qs['v'][0]) == 11:
                return qs['v'][0]

            parts = [p for p in parsed.path.strip('/').split('/') if p]
            if len(parts) >= 2 and parts[0] in ('embed', 'shorts', 'live', 'v'):
                if len(parts[1]) == 11:
                    return parts[1]
            elif len(parts) == 1 and len(parts[0]) == 11:
                return parts[0]

    match = re.search(r'(?:v=|\/embed\/|\/shorts\/|\/live\/|\/v\/|youtu\.be\/|\/watch\?.*v=)([a-zA-Z0-9_-]{11})', raw)
    if match:
        return match.group(1)

    return None

def extract_tiktok_id(url: str) -> Optional[str]:
    """Extract TikTok video ID from URL."""
    match = re.search(r'tiktok\.com/@[^/]+/video/(\d+)', url)
    if match:
        return match.group(1)
    # Short URLs like vm.tiktok.com/XXXXXXX
    match = re.search(r'(?:vm|vt)\.tiktok\.com/([A-Za-z0-9]+)', url)
    if match:
        return match.group(1)
    return None

def extract_twitter_id(url: str) -> Optional[str]:
    """Extract Tweet/post ID from Twitter/X URL."""
    match = re.search(r'(?:twitter\.com|x\.com)/[^/]+/status/(\d+)', url)
    if match:
        return match.group(1)
    return None

def detect_media_type(source: str) -> tuple[str, str, str]:
    """
    Detects if source is YouTube, TikTok, Twitter/X, Torrent (Magnet), or Direct Video URL.
    Returns: (type, cleaned_source_or_id, default_title)
    """
    source = source.strip()

    # 1. Magnet link
    if source.lower().startswith("magnet:?"):
        title = "Torrent Stream"
        try:
            parsed = urllib.parse.urlparse(source)
            params = urllib.parse.parse_qs(parsed.query)
            if "dn" in params and params["dn"]:
                title = urllib.parse.unquote_plus(params["dn"][0])
            elif "xt" in params and params["xt"]:
                xt_val = params["xt"][0]
                title = f"Magnet: {xt_val.split(':')[-1][:12]}..."
        except Exception:
            pass
        return "torrent", source, title

    # 2. YouTube
    yt_id = extract_youtube_id(source)
    if yt_id:
        return "youtube", yt_id, f"YouTube Video ({yt_id})"

    # 3. TikTok
    if "tiktok.com" in source:
        tiktok_id = extract_tiktok_id(source)
        if tiktok_id:
            return "tiktok", tiktok_id, f"TikTok Video ({tiktok_id})"
        return "tiktok", source, "TikTok Video"

    # 4. Twitter / X
    if "twitter.com" in source or "x.com" in source:
        tweet_id = extract_twitter_id(source)
        if tweet_id:
            return "twitter", tweet_id, f"Post de X ({tweet_id})"
        return "twitter", source, "Tweet / X Post"

    # 5. Direct Video URL or generic link
    if source.startswith("http://") or source.startswith("https://"):
        try:
            parsed = urllib.parse.urlparse(source)
            path = parsed.path.strip("/")
            filename = path.split("/")[-1] if path else "Video Stream"
            return "url", source, urllib.parse.unquote(filename)
        except Exception:
            return "url", source, "Video Stream"

    return "url", source, "Media Stream"

def _extract_x_direct_sync(url: str) -> Optional[dict]:
    if not yt_dlp:
        return None
    try:
        ydl_opts = {
            'format': 'best[ext=mp4]/best',
            'quiet': True,
            'no_warnings': True
        }
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info and info.get('url'):
                return {
                    'stream_url': info.get('url'),
                    'title': info.get('title'),
                    'thumbnail': info.get('thumbnail'),
                    'duration': float(info.get('duration') or 0.0)
                }
    except Exception:
        pass
    return None

async def _extract_tiktok_direct(url_or_id: str) -> Optional[dict]:
    try:
        target_url = url_or_id if url_or_id.startswith('http') else f"https://www.tiktok.com/video/{url_or_id}"
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            resp = await client.get(f"https://www.tikwm.com/api/?url={urllib.parse.quote(target_url, safe='')}")
            if resp.status_code == 200:
                data = resp.json()
                if data.get('code') == 0:
                    d = data.get('data', {})
                    play_url = d.get('play')
                    if play_url:
                        return {
                            'stream_url': play_url,
                            'title': d.get('title') or 'TikTok Video',
                            'thumbnail': d.get('cover'),
                            'duration': float(d.get('duration') or 0.0)
                        }
    except Exception:
        pass
    return None

async def fetch_media_title(media_type: str, source: str, default_title: str) -> tuple[str, Optional[str], float, str]:
    """
    Returns: (title, thumbnail, duration, final_source)
    For TikTok and Twitter, if a direct mp4 stream is extracted, final_source will be that MP4 URL.
    """
    title = default_title
    thumbnail = None
    duration = 0.0
    final_source = source

    if media_type == "youtube":
        yt_id = source
        thumbnail = f"https://img.youtube.com/vi/{yt_id}/hqdefault.jpg"
        try:
            async with httpx.AsyncClient(timeout=4.0) as client:
                res = await client.get(
                    f"https://noembed.com/embed?url=https://www.youtube.com/watch?v={yt_id}"
                )
                if res.status_code == 200:
                    data = res.json()
                    t = data.get("title")
                    if t and not t.startswith("http"):
                        title = t
        except Exception:
            pass

    elif media_type == "torrent":
        thumbnail = "https://webtorrent.io/img/network.png"
        # If server-side torrent proxy is active, add the magnet to start downloading
        # and route the source through our HTTP stream endpoint!
        if torrent_proxy and torrent_proxy.available:
            try:
                dl_id = await torrent_proxy.add_magnet(source)
                if dl_id:
                    # Give it a short moment (up to 4s) to quickly grab metadata if peers respond fast
                    has_meta = await torrent_proxy.wait_for_metadata(dl_id, timeout=4.0)
                    dl_status = torrent_proxy.get_status(dl_id)
                    if dl_status and dl_status.get("name"):
                        title = dl_status["name"]
                    final_source = f"/api/torrent-stream/{dl_id}"
            except Exception as e:
                print(f"Torrent proxy add failed, falling back to WebTorrent: {e}")

    elif media_type == "tiktok":
        thumbnail = "https://www.tiktok.com/favicon.ico"
        # 1. Attempt direct MP4 stream extraction for full real-time sync
        tt_info = await _extract_tiktok_direct(source)
        if tt_info and tt_info.get('stream_url'):
            final_source = tt_info['stream_url']
            if tt_info.get('title'):
                title = tt_info['title'][:80]
            if tt_info.get('thumbnail'):
                thumbnail = tt_info['thumbnail']
            if tt_info.get('duration'):
                duration = tt_info['duration']
        else:
            # Fallback to oEmbed metadata
            try:
                target_url = f"https://www.tiktok.com/video/{source}" if source.isdigit() else source
                encoded = urllib.parse.quote(target_url, safe='')
                async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
                    res = await client.get(
                        f"https://www.tiktok.com/oembed?url={encoded}",
                        headers={"User-Agent": "Mozilla/5.0"}
                    )
                    if res.status_code == 200:
                        data = res.json()
                        t = data.get("title")
                        if t:
                            title = t[:80]
                        elif data.get("author_name"):
                            title = f"TikTok de @{data.get('author_name')}"
                        thumb = data.get("thumbnail_url")
                        if thumb:
                            thumbnail = thumb
            except Exception:
                pass

    elif media_type == "twitter":
        thumbnail = "https://abs.twimg.com/favicons/twitter.3.ico"
        tweet_url = f"https://twitter.com/i/status/{source}" if source.isdigit() else source
        # 1. Attempt direct MP4 stream extraction for full real-time sync
        if yt_dlp:
            x_info = await asyncio.to_thread(_extract_x_direct_sync, tweet_url)
            if x_info and x_info.get('stream_url'):
                final_source = x_info['stream_url']
                if x_info.get('title'):
                    title = x_info['title'][:80]
                if x_info.get('thumbnail'):
                    thumbnail = x_info['thumbnail']
                if x_info.get('duration'):
                    duration = x_info['duration']
        
        # If no stream url extracted, fallback to oEmbed title
        if final_source == source:
            try:
                encoded = urllib.parse.quote(tweet_url, safe='')
                async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
                    res = await client.get(
                        f"https://publish.twitter.com/oembed?url={encoded}&omit_script=true",
                        headers={"User-Agent": "Mozilla/5.0"}
                    )
                    if res.status_code == 200:
                        data = res.json()
                        author = data.get("author_name", "")
                        text = data.get("html", "")
                        import re as _re
                        clean = _re.sub(r'<[^>]+>', '', text).strip()
                        snippet = clean[:60].strip()
                        if author and snippet:
                            title = f"@{author}: {snippet}..."
                        elif author:
                            title = f"Tweet de @{author}"
            except Exception:
                pass

    return title, thumbnail, duration, final_source


class Room:
    def __init__(self, room_id: str, is_private: bool = False):
        self.room_id = room_id
        self.title = f"Room {room_id}"
        self.is_private = is_private
        self.users: Dict[str, UserInfo] = {}
        self.connections: Dict[str, WebSocket] = {}
        self.playback = PlaybackState()
        self.current_media: Optional[MediaItem] = None
        self.playlist: List[MediaItem] = []
        self.chat_history: List[ChatMessage] = []
        self.leader_id: Optional[str] = None
        self.lock_controls: bool = False
        self.voteskips: Set[str] = set()

    async def broadcast(self, event_type: str, data: dict, exclude_user_id: Optional[str] = None):
        message = {"type": event_type, "data": data}
        dead_connections = []
        for user_id, ws in list(self.connections.items()):
            if exclude_user_id and user_id == exclude_user_id:
                continue
            try:
                await ws.send_json(message)
            except Exception:
                dead_connections.append(user_id)

        for user_id in dead_connections:
            await self.remove_user(user_id)

    async def add_user(self, user_id: str, username: str, websocket: WebSocket):
        self.connections[user_id] = websocket
        is_leader = (self.leader_id is None) or (self.leader_id == user_id)
        if is_leader:
            self.leader_id = user_id

        user_info = UserInfo(user_id=user_id, username=username, is_leader=is_leader)
        self.users[user_id] = user_info

        init_state = self.get_full_state()
        await websocket.send_json({"type": "init", "data": init_state})

        await self.broadcast("user_joined", {
            "user": user_info.model_dump(),
            "users_count": len(self.users),
            "users": [u.model_dump() for u in self.users.values()]
        })

        await self.add_chat_message(
            user_id="system",
            username="System",
            text=f"👋 {username} entered the room.",
            is_system=True
        )

    async def remove_user(self, user_id: str):
        if user_id in self.connections:
            del self.connections[user_id]
        
        user_info = self.users.pop(user_id, None)
        if user_id in self.voteskips:
            self.voteskips.remove(user_id)

        if self.leader_id == user_id:
            if self.users:
                self.leader_id = next(iter(self.users.keys()))
                self.users[self.leader_id].is_leader = True
            else:
                self.leader_id = None

        if user_info:
            await self.broadcast("user_left", {
                "user_id": user_id,
                "username": user_info.username,
                "users_count": len(self.users),
                "users": [u.model_dump() for u in self.users.values()],
                "leader_id": self.leader_id
            })

            await self.add_chat_message(
                user_id="system",
                username="System",
                text=f"💨 {user_info.username} left the room.",
                is_system=True
            )

    async def add_chat_message(self, user_id: str, username: str, text: str, is_system: bool = False, badge: Optional[str] = None):
        msg = ChatMessage(
            user_id=user_id,
            username=username,
            text=text,
            is_system=is_system,
            badge=badge or ("👑 DJ" if user_id == self.leader_id else None)
        )
        self.chat_history.append(msg)
        if len(self.chat_history) > 150:
            self.chat_history.pop(0)

        await self.broadcast("chat_message", msg.model_dump())

    async def update_playback(self, state: Optional[str] = None, current_time: Optional[float] = None, sender_id: Optional[str] = None):
        user = self.users.get(sender_id)
        is_sender_leader = (sender_id == self.leader_id) if (sender_id and self.leader_id) else False

        # If controls are locked to the host and sender is not the host, reject and re-sync sender
        if self.lock_controls and not is_sender_leader:
            if sender_id and sender_id in self.connections:
                try:
                    ws = self.connections[sender_id]
                    await ws.send_json({
                        "type": "playback_rejected",
                        "data": {
                            "message": "🔒 Solo el Host (👑) tiene permiso para pausar o reanudar el video.",
                            "playback": self.playback.model_dump()
                        }
                    })
                except Exception:
                    pass
            return

        if state is not None:
            self.playback.state = state
        if current_time is not None:
            self.playback.current_time = float(current_time)
        self.playback.last_update = time.time()

        sender_name = user.username if user else "Alguien"

        # Broadcast update to all other users immediately
        await self.broadcast("playback_update", {
            "playback": self.playback.model_dump(),
            "updated_by": sender_name,
            "is_leader": is_sender_leader,
            "sender_id": sender_id
        }, exclude_user_id=sender_id)

        # Chat notification for significant play/pause
        mins = int(self.playback.current_time // 60)
        secs = int(self.playback.current_time % 60)
        prefix = f"👑 [Host {sender_name}]" if is_sender_leader else sender_name

        if state == "paused":
            await self.add_chat_message(
                user_id="system",
                username="System",
                text=f"⏸️ {prefix} pausó el video para todos en {mins:02d}:{secs:02d}",
                is_system=True
            )
        elif state == "playing":
            await self.add_chat_message(
                user_id="system",
                username="System",
                text=f"▶️ {prefix} reanudó el video para todos en {mins:02d}:{secs:02d}",
                is_system=True
            )

    async def update_heartbeat(self, current_time: float, sender_id: str):
        """Host sends periodic playback time heartbeat so viewers stay 100% in sync."""
        if sender_id == self.leader_id and self.playback.state == "playing":
            self.playback.current_time = float(current_time)
            self.playback.last_update = time.time()

    async def set_lock_controls(self, locked: bool, sender_id: str):
        if sender_id == self.leader_id:
            self.lock_controls = locked
            leader_name = self.users.get(sender_id).username if sender_id in self.users else "Host"
            await self.broadcast("lock_controls_changed", {
                "lock_controls": self.lock_controls,
                "leader_id": self.leader_id
            })
            status_text = "activó el Modo Estricto: Solo el Host (👑) puede controlar la reproducción" if locked else "desactivó el bloqueo: Ahora todos los miembros pueden controlar la reproducción"
            await self.add_chat_message(
                user_id="system",
                username="System",
                text=f"🔒 {leader_name} {status_text}.",
                is_system=True
            )

    async def add_media_to_playlist(self, source: str, title: Optional[str], added_by: str, play_now: bool = False) -> MediaItem:
        media_type, cleaned_source, default_title = detect_media_type(source)
        real_title, thumb, duration, final_source = await fetch_media_title(media_type, cleaned_source, title or default_title)

        item = MediaItem(
            type=media_type,
            source=final_source,
            title=real_title,
            thumbnail=thumb,
            duration=duration,
            added_by=added_by
        )

        if play_now or self.current_media is None:
            self.current_media = item
            self.playback.state = "playing"
            self.playback.current_time = 0.0
            self.playback.last_update = time.time()
            self.voteskips.clear()

            await self.broadcast("media_changed", {
                "media": self.current_media.model_dump(),
                "playback": self.playback.model_dump(),
                "playlist": [p.model_dump() for p in self.playlist]
            })

            await self.add_chat_message(
                user_id="system",
                username="System",
                text=f"▶️ Now playing: [{media_type.upper()}] {item.title}",
                is_system=True
            )
        else:
            self.playlist.append(item)
            await self.broadcast("playlist_updated", {
                "playlist": [p.model_dump() for p in self.playlist]
            })

            await self.add_chat_message(
                user_id="system",
                username="System",
                text=f"➕ {added_by} queued: [{media_type.upper()}] {item.title}",
                is_system=True
            )

        return item

    async def play_playlist_item(self, item_id: str, triggered_by: str = "Someone"):
        target_item = None
        new_playlist = []
        for it in self.playlist:
            if it.id == item_id and target_item is None:
                target_item = it
            else:
                new_playlist.append(it)

        if target_item:
            self.playlist = new_playlist
            self.current_media = target_item
            self.playback.state = "playing"
            self.playback.current_time = 0.0
            self.playback.last_update = time.time()
            self.voteskips.clear()

            await self.broadcast("media_changed", {
                "media": self.current_media.model_dump(),
                "playback": self.playback.model_dump(),
                "playlist": [p.model_dump() for p in self.playlist]
            })

            await self.add_chat_message(
                user_id="system",
                username="System",
                text=f"▶️ {triggered_by} started: {target_item.title}",
                is_system=True
            )

    async def skip_media(self, triggered_by: str = "System"):
        self.voteskips.clear()
        if self.playlist:
            next_media = self.playlist.pop(0)
            self.current_media = next_media
            self.playback.state = "playing"
            self.playback.current_time = 0.0
            self.playback.last_update = time.time()

            await self.broadcast("media_changed", {
                "media": self.current_media.model_dump(),
                "playback": self.playback.model_dump(),
                "playlist": [p.model_dump() for p in self.playlist]
            })

            await self.add_chat_message(
                user_id="system",
                username="System",
                text=f"⏭️ Skipped by {triggered_by}. Now playing: {next_media.title}",
                is_system=True
            )
        else:
            self.current_media = None
            self.playback.state = "paused"
            self.playback.current_time = 0.0
            self.playback.last_update = time.time()

            await self.broadcast("media_changed", {
                "media": None,
                "playback": self.playback.model_dump(),
                "playlist": []
            })

            await self.add_chat_message(
                user_id="system",
                username="System",
                text=f"⏹️ Playlist ended.",
                is_system=True
            )

    async def remove_playlist_item(self, item_id: str, removed_by: str):
        self.playlist = [item for item in self.playlist if item.id != item_id]
        await self.broadcast("playlist_updated", {
            "playlist": [p.model_dump() for p in self.playlist]
        })

    async def vote_skip(self, user_id: str) -> dict:
        if user_id not in self.users:
            return {"success": False}
        
        self.voteskips.add(user_id)
        votes_count = len(self.voteskips)
        total_users = max(1, len(self.users))
        needed = (total_users // 2) + 1

        username = self.users[user_id].username

        await self.add_chat_message(
            user_id="system",
            username="System",
            text=f"🗳️ {username} voted to skip ({votes_count}/{needed})",
            is_system=True
        )

        if votes_count >= needed:
            await self.skip_media(triggered_by=f"Vote ({votes_count}/{needed})")
            return {"skipped": True, "votes": votes_count, "needed": needed}

        await self.broadcast("voteskip_update", {
            "votes": votes_count,
            "needed": needed
        })
        return {"skipped": False, "votes": votes_count, "needed": needed}

    def get_full_state(self) -> dict:
        return {
            "room_id": self.room_id,
            "title": self.title,
            "leader_id": self.leader_id,
            "lock_controls": self.lock_controls,
            "users": [u.model_dump() for u in self.users.values()],
            "current_media": self.current_media.model_dump() if self.current_media else None,
            "playback": self.playback.model_dump(),
            "playlist": [p.model_dump() for p in self.playlist],
            "chat_history": [m.model_dump() for m in self.chat_history[-50:]],
            "server_time": time.time(),
            "voteskips_count": len(self.voteskips),
            "voteskips_needed": (max(1, len(self.users)) // 2) + 1
        }


class RoomManager:
    def __init__(self):
        self.rooms: Dict[str, Room] = {}

    def get_or_create_room(self, room_id: str, is_private: Optional[bool] = None) -> Room:
        clean_id = re.sub(r'[^a-zA-Z0-9_-]', '', room_id.lower()) or "default"
        if clean_id not in self.rooms:
            self.rooms[clean_id] = Room(clean_id, is_private=bool(is_private))
        elif is_private is not None:
            self.rooms[clean_id].is_private = is_private
        return self.rooms[clean_id]

    def list_rooms(self) -> List[dict]:
        return [
            {
                "room_id": r.room_id,
                "title": r.title,
                "users_count": len(r.users),
                "now_playing": r.current_media.title if r.current_media else "Nothing playing"
            }
            for r in self.rooms.values()
            if not r.is_private
        ]

room_manager = RoomManager()
room_manager.get_or_create_room("default")
