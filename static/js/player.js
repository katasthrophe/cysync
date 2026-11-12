/**
 * Universal Player Controller for CyTube Clone:
 * Synchronizes YouTube IFrame Player API, WebTorrent, and HTML5 Video.
 */

// Helper to ensure YouTube IFrame API is loaded regardless of race conditions
function ensureYouTubeAPI(onReadyCallback) {
  if (window.YT && window.YT.Player && typeof window.YT.Player === 'function') {
    onReadyCallback();
    return;
  }

  const existingReady = window.onYouTubeIframeAPIReady;
  window.onYouTubeIframeAPIReady = function() {
    if (typeof existingReady === 'function') existingReady();
    onReadyCallback();
  };

  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    if (window.YT && window.YT.Player && typeof window.YT.Player === 'function') {
      clearInterval(poll);
      onReadyCallback();
    } else if (attempts > 60) {
      clearInterval(poll);
      console.warn('YouTube Iframe API timed out.');
    }
  }, 100);

  if (!document.getElementById('yt-iframe-api-script')) {
    const script = document.createElement('script');
    script.id = 'yt-iframe-api-script';
    script.src = 'https://www.youtube.com/iframe_api';
    const firstScript = document.getElementsByTagName('script')[0];
    if (firstScript && firstScript.parentNode) {
      firstScript.parentNode.insertBefore(script, firstScript);
    } else {
      document.head.appendChild(script);
    }
  }
}

class UniversalPlayer {
  constructor(options = {}) {
    this.ytContainerId = options.ytContainerId || 'yt-player-container';
    this.torrentVideoId = options.torrentVideoId || 'torrent-player';
    this.hudElementId = options.hudElementId || 'torrent-hud';
    this.onPlaybackChange = options.onPlaybackChange || (() => {});
    this.onMediaEnded = options.onMediaEnded || (() => {});
    this.onPlayerError = options.onPlayerError || (() => {});

    this.ytPlayer = null;
    this.ytReady = false;
    this.currentYtVideoId = null;

    this.torrentClient = null;
    this.currentTorrent = null;

    this.embedFrame = null; // For TikTok / Twitter iframes

    this.currentMedia = null;
    this.currentType = null; // 'youtube' | 'torrent' | 'url' | 'tiktok' | 'twitter' | null

    this.isApplyingSync = false;
    this.syncCooldownUntil = 0;
    this.statsInterval = null;

    this.initPlayers();
  }

  initPlayers() {
    this.torrentVideo = document.getElementById(this.torrentVideoId);
    this.hudElement = document.getElementById(this.hudElementId);
    this.ytContainer = document.getElementById(this.ytContainerId);
    this.playOverlay = document.getElementById('torrent-play-overlay');
    this.embedContainer = document.getElementById('embed-player-container');

    if (this.playOverlay && this.torrentVideo) {
      this.playOverlay.addEventListener('click', () => {
        this.torrentVideo.play().then(() => {
          this.playOverlay.style.display = 'none';
        }).catch(err => {
          console.warn('Playback error after overlay click:', err);
        });
      });
    }

    // Setup HTML5 video event listeners
    if (this.torrentVideo) {
      this.torrentVideo.addEventListener('play', () => {
        if (this.playOverlay) this.playOverlay.style.display = 'none';
        if (this.currentType !== 'youtube' && !this.isApplyingSync) {
          this.onPlaybackChange('play', this.torrentVideo.currentTime);
        }
      });

      this.torrentVideo.addEventListener('pause', () => {
        if (this.currentType !== 'youtube' && !this.isApplyingSync) {
          this.onPlaybackChange('pause', this.torrentVideo.currentTime);
        }
      });

      this.torrentVideo.addEventListener('seeked', () => {
        if (this.currentType !== 'youtube' && !this.isApplyingSync) {
          this.onPlaybackChange('seek', this.torrentVideo.currentTime);
        }
      });

      this.torrentVideo.addEventListener('ended', () => {
        if (this.currentType !== 'youtube') {
          this.onMediaEnded();
        }
      });
    }

    // Initialize WebTorrent Client with robust config
    this._torrentMetaTimeout = null;
    this._ensureTorrentClient();

    // Pre-warm YouTube API
    ensureYouTubeAPI(() => {
      this.ytReady = true;
      console.log('YouTube API Loaded & Ready');
      if (this.pendingYTVideoId) {
        this.loadYouTube(this.pendingYTVideoId, this.pendingTime || 0, this.pendingState || 'playing');
        this.pendingYTVideoId = null;
      }
    });
  }

  loadMedia(mediaItem, initialTime = 0, initialState = 'paused') {
    this.currentMedia = mediaItem;
    const placeholder = document.getElementById('empty-player-state');
    if (placeholder) placeholder.style.display = 'none';

    if (!mediaItem) {
      this.stopAll();
      if (placeholder) placeholder.style.display = 'flex';
      return;
    }

    this.currentType = mediaItem.type;

    if (mediaItem.type === 'youtube') {
      this.hideTorrent();
      this.hideEmbed();
      this.showYouTube();
      this.loadYouTube(mediaItem.source, initialTime, initialState);
    } else if (mediaItem.type === 'torrent') {
      this.hideYouTube();
      this.hideEmbed();
      this.showTorrent();
      if (mediaItem.source && mediaItem.source.startsWith('/api/torrent-stream/')) {
        // Server-side torrent proxy stream: full standard BitTorrent (TCP/UDP/DHT)
        this.loadServerTorrent(mediaItem.source, initialTime, initialState);
      } else {
        // Direct magnet URI fallback to WebTorrent (WebRTC)
        this.loadTorrent(mediaItem.source, initialTime, initialState);
      }
    } else if (mediaItem.type === 'url') {
      this.hideYouTube();
      this.hideEmbed();
      this.showTorrent();
      this.loadDirectUrl(mediaItem.source, initialTime, initialState);
    } else if (mediaItem.type === 'tiktok') {
      const isDirectStream = mediaItem.source && mediaItem.source.startsWith('http') && 
        (mediaItem.source.includes('tiktokcdn') || mediaItem.source.includes('mime_type=video_mp4') || mediaItem.source.includes('.mp4') || mediaItem.source.includes('tikwm'));

      if (isDirectStream) {
        // Direct MP4 stream extracted for TikTok: fully synchronized via HTML5 video player!
        this.hideYouTube();
        this.hideEmbed();
        this.showTorrent();
        this.loadDirectUrl(mediaItem.source, initialTime, initialState);
      } else {
        this.hideYouTube();
        this.hideTorrent();
        this.showEmbed();
        this.loadTikTok(mediaItem.source);
      }
    } else if (mediaItem.type === 'twitter') {
      const isDirectStream = mediaItem.source && mediaItem.source.startsWith('http') && 
        (mediaItem.source.includes('.mp4') || mediaItem.source.includes('twimg.com') || mediaItem.source.includes('video.twimg'));

      if (isDirectStream) {
        // Direct MP4 stream extracted for X: fully synchronized via HTML5 video player!
        this.hideYouTube();
        this.hideEmbed();
        this.showTorrent();
        this.loadDirectUrl(mediaItem.source, initialTime, initialState);
      } else {
        this.hideYouTube();
        this.hideTorrent();
        this.showEmbed();
        this.loadTwitter(mediaItem.source);
      }
    }
  }

  showYouTube() {
    if (this.ytContainer) this.ytContainer.style.display = 'block';
  }

  hideYouTube() {
    if (this.ytContainer) this.ytContainer.style.display = 'none';
    if (this.ytPlayer && typeof this.ytPlayer.pauseVideo === 'function') {
      try { this.ytPlayer.pauseVideo(); } catch (e) {}
    }
  }

  showTorrent() {
    if (this.torrentVideo) this.torrentVideo.style.display = 'block';
  }

  hideTorrent() {
    if (this.torrentVideo) {
      this.torrentVideo.style.display = 'none';
      try { this.torrentVideo.pause(); } catch (e) {}
    }
    if (this.hudElement) this.hudElement.style.display = 'none';
    if (this.playOverlay) this.playOverlay.style.display = 'none';
  }

  showEmbed() {
    if (this.embedContainer) {
      this.embedContainer.style.display = 'flex';
    }
  }

  hideEmbed() {
    if (this.embedContainer) {
      this.embedContainer.style.display = 'none';
      this.embedContainer.innerHTML = '';
    }
  }

  loadTikTok(source) {
    if (!this.embedContainer) return;
    // Extract video ID from URL or numeric ID
    const match = String(source).match(/video\/(\d+)/);
    const videoId = match ? match[1] : (String(source).match(/^\d+$/) ? String(source) : null);

    const embedUrl = videoId
      ? `https://www.tiktok.com/player/v1/${videoId}?autoplay=1`
      : (source.startsWith('http') ? source : `https://www.tiktok.com/video/${source}`);

    this.embedContainer.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; height:100%; padding: 10px;">
        <iframe 
          src="${embedUrl}"
          style="width: 340px; max-width: 95%; height: 95%; min-height: 480px; border: none; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.6);"
          allow="accelerometer; autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowfullscreen>
        </iframe>
        <div style="margin-top: 6px; font-size: 12px; color: #94a3b8;">
          🎵 TikTok oficial (reproduce directo en el widget)
        </div>
      </div>`;
  }

  loadTwitter(tweetIdOrUrl) {
    if (!this.embedContainer) return;
    // Extract numeric ID if given as a full URL
    const match = String(tweetIdOrUrl).match(/status\/(\d+)/);
    const tweetId = match ? match[1] : tweetIdOrUrl;

    this.embedContainer.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; width:100%; height:100%; overflow-y:auto; padding: 10px;">
        <div id="twitter-widget-mount" style="max-width: 550px; width: 100%; min-height: 300px; display: flex; justify-content: center; align-items: center;">
          <blockquote class="twitter-tweet" data-theme="dark" data-media-max-view="video">
            <a href="https://twitter.com/x/status/${tweetId}">Cargando video de X...</a>
          </blockquote>
        </div>
      </div>`;

    const renderWidget = () => {
      const mount = document.getElementById('twitter-widget-mount');
      if (window.twttr && window.twttr.widgets && mount) {
        try {
          mount.innerHTML = ''; // Clear fallback blockquote
          window.twttr.widgets.createTweet(tweetId, mount, {
            theme: 'dark',
            align: 'center',
            conversation: 'none'
          }).then(el => {
            if (!el) {
              // Fallback to iframe if createTweet returns null (e.g. adblocker)
              mount.innerHTML = `
                <iframe src="https://platform.twitter.com/embed/Tweet.html?id=${tweetId}&theme=dark" 
                        style="width: 100%; min-height: 350px; border: none; border-radius: 12px;"></iframe>`;
            }
          }).catch(err => {
            console.warn('twttr createTweet error:', err);
            mount.innerHTML = `
              <iframe src="https://platform.twitter.com/embed/Tweet.html?id=${tweetId}&theme=dark" 
                      style="width: 100%; min-height: 350px; border: none; border-radius: 12px;"></iframe>`;
          });
        } catch (e) {
          console.warn('twttr widgets error:', e);
        }
      }
    };

    if (window.twttr && window.twttr.widgets) {
      renderWidget();
    } else {
      this.injectScript('https://platform.twitter.com/widgets.js', () => {
        // Give widgets a moment to initialize
        setTimeout(renderWidget, 100);
      });
    }
  }

  injectScript(src, callback) {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (typeof callback === 'function') callback();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    if (typeof callback === 'function') {
      script.onload = callback;
    }
    document.body.appendChild(script);
  }

  loadYouTube(videoId, initialTime = 0, initialState = 'playing') {
    if (!this.ytReady) {
      this.pendingYTVideoId = videoId;
      this.pendingTime = initialTime;
      this.pendingState = initialState;
      return;
    }

    this.isApplyingSync = true;
    this.syncCooldownUntil = Date.now() + 1500;

    if (this.ytPlayer && typeof this.ytPlayer.loadVideoById === 'function') {
      try {
        this.currentYtVideoId = videoId;
        this.ytPlayer.loadVideoById({
          videoId: videoId,
          startSeconds: Math.floor(initialTime)
        });

        if (initialState === 'playing') {
          setTimeout(() => {
            try { this.ytPlayer.playVideo(); } catch (e) {}
          }, 300);
        } else {
          setTimeout(() => {
            try { this.ytPlayer.pauseVideo(); } catch (e) {}
          }, 300);
        }

        setTimeout(() => { this.isApplyingSync = false; }, 1200);
        return;
      } catch (err) {
        console.warn('Rebuilding YT Player after error:', err);
      }
    }

    if (this.ytPlayer && typeof this.ytPlayer.destroy === 'function') {
      try { this.ytPlayer.destroy(); } catch (e) {}
      this.ytPlayer = null;
    }

    if (this.ytContainer) {
      this.ytContainer.innerHTML = '<div id="yt-player-mount"></div>';
    }

    this.currentYtVideoId = videoId;

    try {
      this.ytPlayer = new YT.Player('yt-player-mount', {
        width: '100%',
        height: '100%',
        videoId: videoId,
        playerVars: {
          autoplay: (initialState === 'playing') ? 1 : 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          start: Math.floor(initialTime),
          fs: 1
        },
        events: {
          onReady: (event) => {
            console.log('YouTube Player Ready with video:', videoId);
            this.isApplyingSync = true;
            this.syncCooldownUntil = Date.now() + 1500;

            if (initialTime > 0) {
              try { event.target.seekTo(initialTime, true); } catch (e) {}
            }
            if (initialState === 'playing') {
              try { event.target.playVideo(); } catch (e) {}
            } else {
              try { event.target.pauseVideo(); } catch (e) {}
            }
            setTimeout(() => { this.isApplyingSync = false; }, 1200);
          },
          onStateChange: (event) => {
            this.handleYTStateChange(event);
          },
          onError: (event) => {
            this.handleYTError(event.data);
          }
        }
      });
    } catch (e) {
      console.error('Failed to create YT.Player instance:', e);
      this.isApplyingSync = false;
    }
  }

  handleYTStateChange(event) {
    if (this.currentType !== 'youtube') return;
    if (this.isApplyingSync) return;

    const time = this.getCurrentTime();

    if (event.data === YT.PlayerState.PLAYING) {
      this.onPlaybackChange('play', time);
    } else if (event.data === YT.PlayerState.PAUSED) {
      this.onPlaybackChange('pause', time);
    } else if (event.data === YT.PlayerState.ENDED) {
      this.onMediaEnded();
    }
  }

  handleYTError(errorCode) {
    let msg = 'YouTube error: ' + errorCode;
    if (errorCode === 101 || errorCode === 150) {
      msg = '⚠️ El creador ha desactivado la inserción de este video en reproductores externos.';
    } else if (errorCode === 100) {
      msg = '⚠️ Video de YouTube no encontrado (puede ser privado o haber sido eliminado).';
    } else if (errorCode === 2) {
      msg = '⚠️ Enlace o ID de YouTube inválido.';
    }
    console.warn(msg);
    this.onPlayerError(msg);
  }

  /**
   * Ensures the WebTorrent client is alive and functional.
   * Recreates it if destroyed or errored.
   */
  _ensureTorrentClient() {
    if (this.torrentClient && !this.torrentClient.destroyed) {
      return true;
    }
    if (typeof WebTorrent === 'undefined') {
      console.error('WebTorrent library not loaded');
      return false;
    }
    try {
      this.torrentClient = new WebTorrent({
        tracker: {
          rtcConfig: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
              { urls: 'stun:stun2.l.google.com:19302' },
              { urls: 'stun:global.stun.twilio.com:3478' },
              { urls: 'stun:stun.stunprotocol.org:3478' }
            ]
          }
        },
        maxConns: 80
      });
      this.torrentClient.on('error', (err) => {
        console.error('WebTorrent client-level error:', err);
      });
      console.log('WebTorrent client (re)initialized');
      return true;
    } catch (e) {
      console.error('Failed to create WebTorrent client:', e);
      return false;
    }
  }

  /**
   * Extracts the info-hash from a magnet URI for reliable torrent matching.
   */
  _extractInfoHash(magnetURI) {
    const match = magnetURI.match(/btih:([a-fA-F0-9]{40})/i);
    if (match) return match[1].toLowerCase();
    // Base32 encoded hash
    const b32 = magnetURI.match(/btih:([A-Z2-7]{32})/i);
    if (b32) return b32[1].toLowerCase();
    return null;
  }

  loadTorrent(magnetURI, initialTime = 0, initialState = 'playing') {
    if (!this._ensureTorrentClient()) {
      alert('La librería WebTorrent no está disponible. Intenta recargar la página.');
      return;
    }

    // Clean up previous stats monitor
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.hudElement) {
      this.hudElement.style.display = 'flex';
      this.updateHud({ peers: 0, speed: 0, progress: 0, status: '🔗 Conectando a trackers WebRTC...' });
    }

    // === 1. Inject verified active WSS trackers ===
    let finalMagnet = magnetURI;
    const activeTrackers = [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.webtorrent.dev',
      'wss://tracker.files.fm:7073/announce',
      'wss://tracker.btorrent.xyz'
    ];

    for (const tracker of activeTrackers) {
      const encoded = encodeURIComponent(tracker);
      if (!finalMagnet.includes(encoded) && !finalMagnet.includes(tracker)) {
        finalMagnet += `&tr=${encoded}`;
      }
    }

    // === 2. Find existing torrent by info-hash (not full magnet string) ===
    const infoHash = this._extractInfoHash(finalMagnet);
    let existingTorrent = null;
    if (infoHash) {
      existingTorrent = this.torrentClient.get(infoHash);
    }

    // === 3. Core handler once torrent metadata is ready ===
    const onTorrentReady = (torrent) => {
      this.currentTorrent = torrent;
      console.log('Torrent metadata ready:', torrent.name, '| Files:', torrent.files.length);

      // Find best video file
      const videoExtensions = /\.(mp4|m4v|webm|mkv|mov|ogv|avi|ts|wmv)$/i;
      const videoFiles = torrent.files.filter(f => videoExtensions.test(f.name));
      const videoFile = videoFiles.sort((a, b) => b.length - a.length)[0] || torrent.files[0];

      if (!videoFile) {
        this.updateHud({ status: '❌ No se encontró ningún archivo de video en el torrent.' });
        return;
      }

      // Deselect all non-video files to save bandwidth
      torrent.files.forEach(f => {
        if (f !== videoFile) {
          f.deselect();
        }
      });
      videoFile.select();

      console.log(`Selected video file: ${videoFile.name} (${(videoFile.length / 1024 / 1024).toFixed(1)} MB)`);

      this.updateHud({
        name: videoFile.name,
        status: '⏳ Buffering video...',
        peers: torrent.numPeers,
        progress: ((torrent.progress || 0) * 100).toFixed(1)
      });

      // === 4. Try renderTo first (works great for MP4/WebM), fallback to Blob URL ===
      const isNativeFormat = /\.(mp4|webm|m4v|ogv)$/i.test(videoFile.name);

      if (isNativeFormat) {
        this._renderTorrentNative(videoFile, torrent, initialTime, initialState);
      } else {
        // For MKV, AVI, etc: generate a blob URL
        this._renderTorrentBlob(videoFile, torrent, initialTime, initialState);
      }
    };

    // === 5. Destroy previous torrents, add new one ===
    if (existingTorrent && existingTorrent.ready) {
      // Reuse existing torrent that's already ready
      onTorrentReady(existingTorrent);
    } else {
      // Destroy all other torrents to free resources
      const torrentsToDestroy = this.torrentClient.torrents.filter(t => t !== existingTorrent);
      torrentsToDestroy.forEach(t => {
        try { t.destroy(); } catch (e) {}
      });

      try {
        const torrent = existingTorrent || this.torrentClient.add(finalMagnet, {
          announce: activeTrackers,
          maxWebConns: 6
        });
        this.currentTorrent = torrent;

        torrent.on('wire', () => {
          this.updateHud({
            peers: torrent.numPeers,
            status: torrent.ready ? '📥 Descargando...' : '📋 Obteniendo metadatos...'
          });
        });

        torrent.on('error', (err) => {
          console.error('Torrent error:', err);
          this.updateHud({ status: `❌ Error: ${err.message}` });
        });

        torrent.on('warning', (warn) => {
          console.warn('Torrent warning:', warn);
        });

        torrent.on('noPeers', (announceType) => {
          console.warn(`No peers found via ${announceType}`);
        });

        if (torrent.ready) {
          onTorrentReady(torrent);
        } else {
          torrent.once('ready', () => {
            onTorrentReady(torrent);
          });

          // Metadata timeout: if no metadata after 45s, inform the user
          this._torrentMetaTimeout = setTimeout(() => {
            if (torrent && !torrent.ready && !torrent.destroyed) {
              this.updateHud({
                status: '⚠️ No se pudieron obtener metadatos. El torrent puede no tener seeders WebRTC activos.'
              });
            }
          }, 45000);
        }
      } catch (err) {
        console.error('Failed to add magnet link:', err);
        this.updateHud({ status: `❌ Error al agregar magnet: ${err.message}` });
      }
    }

    // === 6. Stats monitor ===
    let zeroPeerSeconds = 0;
    let hasEverHadPeers = false;
    this.statsInterval = setInterval(() => {
      if (!this.currentTorrent || this.currentTorrent.destroyed) return;

      const t = this.currentTorrent;
      const peers = t.numPeers || 0;
      const speed = t.downloadSpeed || 0;
      const progress = ((t.progress || 0) * 100).toFixed(1);
      const uploaded = t.uploaded || 0;

      if (peers > 0) {
        hasEverHadPeers = true;
        zeroPeerSeconds = 0;
      } else {
        zeroPeerSeconds += 0.5;
      }

      let statusText = '🔗 Conectando a enjambre...';
      if (t.ready) {
        if (peers > 0) {
          if (parseFloat(progress) >= 100) {
            statusText = '✅ Descarga completa — Reproduciendo';
          } else {
            statusText = `📥 Transmitiendo (${progress}%)`;
          }
        } else if (hasEverHadPeers) {
          statusText = '⚡ Peers desconectados — Reconectando...';
        } else {
          statusText = '🔍 Buscando peers WebRTC...';
        }
      } else {
        statusText = '📋 Descargando metadatos del torrent...';
      }

      // Progressive warnings
      if (zeroPeerSeconds >= 60 && peers === 0 && !hasEverHadPeers) {
        statusText = '❌ Sin peers WebRTC después de 1 min. Este torrent probablemente solo tiene seeders BitTorrent tradicionales (incompatibles con el navegador). Prueba un magnet con seeders WebTorrent.';
      } else if (zeroPeerSeconds >= 30 && peers === 0 && !hasEverHadPeers) {
        statusText = '⚠️ Sin peers WebRTC (30s). WebTorrent solo conecta con seeders que usan WebRTC. Torrents populares con WebSeeds tienen mejor compatibilidad.';
      } else if (zeroPeerSeconds >= 15 && peers === 0 && !hasEverHadPeers) {
        statusText = '⏳ Sin peers aún (15s)... WebTorrent necesita seeders WebRTC, no BitTorrent tradicional.';
      }

      this.updateHud({
        peers: peers,
        speed: speed,
        progress: progress,
        status: statusText
      });
    }, 500);
  }

  /**
   * Render torrent video natively via renderTo (best for MP4/WebM).
   * Falls back to blob URL if renderTo fails.
   */
  _renderTorrentNative(videoFile, torrent, initialTime, initialState) {
    if (!this.torrentVideo) return;

    videoFile.renderTo(this.torrentVideo, {
      autoplay: false,
      controls: true
    }, (err, elem) => {
      if (err) {
        console.warn('renderTo failed, falling back to blob URL:', err.message);
        this._renderTorrentBlob(videoFile, torrent, initialTime, initialState);
        return;
      }

      console.log('Torrent video stream attached via renderTo');
      this._onTorrentVideoReady(initialTime, initialState);
    });
  }

  /**
   * Render torrent video via Blob URL (fallback for non-native formats).
   */
  _renderTorrentBlob(videoFile, torrent, initialTime, initialState) {
    if (!this.torrentVideo) return;

    this.updateHud({ status: '⏳ Generando stream de video (Blob)...' });

    videoFile.getBlob((err, blob) => {
      if (err) {
        // If getBlob not available, try getBlobURL
        if (typeof videoFile.getBlobURL === 'function') {
          videoFile.getBlobURL((err2, url) => {
            if (err2) {
              console.error('Failed to create blob URL:', err2);
              this.updateHud({ status: `❌ No se puede reproducir: ${err2.message}` });
              return;
            }
            this.torrentVideo.src = url;
            this._onTorrentVideoReady(initialTime, initialState);
          });
        } else {
          console.error('No blob method available:', err);
          this.updateHud({ status: `❌ Formato no soportado por el navegador: ${videoFile.name}` });
        }
        return;
      }

      const url = URL.createObjectURL(blob);
      this.torrentVideo.src = url;
      this._onTorrentVideoReady(initialTime, initialState);
    });
  }

  /**
   * Common setup after torrent video element is ready.
   */
  _onTorrentVideoReady(initialTime, initialState) {
    this.isApplyingSync = true;
    this.syncCooldownUntil = Date.now() + 2000;

    if (initialTime > 0) {
      try { this.torrentVideo.currentTime = initialTime; } catch (e) {}
    }

    if (initialState === 'playing') {
      this.torrentVideo.play().catch(playErr => {
        console.warn('Autoplay prevented:', playErr.message);
        if (this.playOverlay) {
          this.playOverlay.style.display = 'flex';
        }
      });
    }

    this.updateHud({ status: '▶️ Reproduciendo desde torrent' });
    setTimeout(() => { this.isApplyingSync = false; }, 1500);
  }

  loadServerTorrent(streamUrl, initialTime, initialState) {
    if (!this.torrentVideo) return;
    const downloadId = streamUrl.split('/').pop();

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.hudElement) {
      this.hudElement.style.display = 'flex';
      this.updateHud({
        peers: 0,
        speed: 0,
        progress: 0,
        status: '⚡ Servidor conectando a enjambre BitTorrent (TCP/UDP)...'
      });
    }

    let isVideoAttached = false;

    // Poll status from server to show real-time BitTorrent swarm metrics
    this.statsInterval = setInterval(async () => {
      try {
        const res = await fetch(`/api/torrent-status/${downloadId}`);
        if (!res.ok) return;
        const data = await res.json();

        let statusText = '⚡ Descargando en servidor...';
        if (!data.has_metadata) {
          statusText = '📋 Obteniendo metadatos (DHT/Trackers)...';
        } else if (data.progress >= 100) {
          statusText = '✅ Torrent 100% descargado en servidor';
        } else if (data.num_peers > 0) {
          statusText = `📥 Descargando en servidor (${data.progress}%) [${data.num_peers} peers]`;
        } else {
          statusText = '🔍 Buscando peers BitTorrent en DHT...';
        }

        if (data.error) {
          statusText = `⚠️ ${data.error}`;
        }

        this.updateHud({
          peers: data.num_peers || 0,
          speed: data.download_rate || 0,
          progress: data.progress || 0,
          status: statusText
        });

        // Once metadata arrives and stream is available, attach to video player
        if (data.is_streamable && !isVideoAttached) {
          isVideoAttached = true;
          this.torrentVideo.src = streamUrl;
          this.torrentVideo.controls = true;
          this.isApplyingSync = true;
          this.syncCooldownUntil = Date.now() + 2000;

          if (initialTime > 0) {
            try { this.torrentVideo.currentTime = initialTime; } catch (e) {}
          }

          if (initialState === 'playing') {
            this.torrentVideo.play().catch(() => {
              if (this.playOverlay) this.playOverlay.style.display = 'flex';
            });
          } else {
            this.torrentVideo.pause();
          }

          setTimeout(() => { this.isApplyingSync = false; }, 1500);
        }
      } catch (err) {
        console.warn('Error fetching torrent status:', err);
      }
    }, 1000);
  }

  loadDirectUrl(url, initialTime, initialState) {
    if (!this.torrentVideo) return;
    this.torrentVideo.src = url;
    this.torrentVideo.controls = true;
    this.isApplyingSync = true;
    this.syncCooldownUntil = Date.now() + 1500;

    if (this.hudElement) {
      this.hudElement.style.display = 'flex';
      this.updateHud({
        peers: 1,
        speed: 0,
        progress: 100,
        status: 'Direct HTTP Stream'
      });
    }

    if (initialTime > 0) {
      this.torrentVideo.currentTime = initialTime;
    }
    if (initialState === 'playing') {
      this.torrentVideo.play().catch(() => {
        if (this.playOverlay) this.playOverlay.style.display = 'flex';
      });
    } else {
      this.torrentVideo.pause();
    }
    setTimeout(() => { this.isApplyingSync = false; }, 1000);
  }

  updateHud(info) {
    if (!this.hudElement) return;
    const hudStatus = document.getElementById('hud-status');
    const hudPeers = document.getElementById('hud-peers');
    const hudSpeed = document.getElementById('hud-speed');
    const hudProgress = document.getElementById('hud-progress');

    if (hudStatus && info.status) hudStatus.innerText = info.status;
    if (hudPeers && info.peers !== undefined) hudPeers.innerText = `${info.peers} peers`;
    if (hudSpeed && info.speed !== undefined) hudSpeed.innerText = this.formatBytes(info.speed) + '/s';
    if (hudProgress && info.progress !== undefined) hudProgress.innerText = `${info.progress}%`;
  }

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  sync(targetTime, targetState) {
    if (!this.currentMedia) return;

    this.isApplyingSync = true;

    if (targetState === 'paused') {
      this.pause();
      if (typeof targetTime === 'number' && !isNaN(targetTime)) {
        const cur = this.getCurrentTime();
        if (Math.abs(cur - targetTime) > 0.8) {
          this.seek(targetTime);
        }
      }
      setTimeout(() => { this.isApplyingSync = false; }, 350);
      return;
    }

    // targetState === 'playing'
    if (typeof targetTime === 'number' && !isNaN(targetTime)) {
      const cur = this.getCurrentTime();
      if (Math.abs(cur - targetTime) > 1.8) {
        this.seek(targetTime);
      }
    }
    this.play();

    setTimeout(() => { this.isApplyingSync = false; }, 350);
  }

  getCurrentTime() {
    if (this.currentType === 'youtube' && this.ytPlayer && typeof this.ytPlayer.getCurrentTime === 'function') {
      try { return this.ytPlayer.getCurrentTime() || 0; } catch (e) {}
    } else if (this.torrentVideo) {
      return this.torrentVideo.currentTime || 0;
    }
    return 0;
  }

  getDuration() {
    if (this.currentType === 'youtube' && this.ytPlayer && typeof this.ytPlayer.getDuration === 'function') {
      try { return this.ytPlayer.getDuration() || 0; } catch (e) {}
    } else if (this.torrentVideo) {
      return this.torrentVideo.duration || 0;
    }
    return 0;
  }

  play() {
    if (this.currentType === 'youtube' && this.ytPlayer && typeof this.ytPlayer.playVideo === 'function') {
      try { this.ytPlayer.playVideo(); } catch (e) {}
    } else if (this.torrentVideo) {
      this.torrentVideo.play().catch(() => {
        if (this.playOverlay) this.playOverlay.style.display = 'flex';
      });
    }
  }

  pause() {
    if (this.currentType === 'youtube' && this.ytPlayer && typeof this.ytPlayer.pauseVideo === 'function') {
      try { this.ytPlayer.pauseVideo(); } catch (e) {}
    } else if (this.torrentVideo) {
      this.torrentVideo.pause();
    }
  }

  seek(seconds) {
    if (this.currentType === 'youtube' && this.ytPlayer && typeof this.ytPlayer.seekTo === 'function') {
      try { this.ytPlayer.seekTo(seconds, true); } catch (e) {}
    } else if (this.torrentVideo) {
      this.torrentVideo.currentTime = seconds;
    }
  }

  stopAll() {
    this.hideYouTube();
    this.hideTorrent();
    this.hideEmbed();
    if (this.currentTorrent) {
      try { this.currentTorrent.destroy(); } catch (e) {}
      this.currentTorrent = null;
    }
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    if (this._torrentMetaTimeout) {
      clearTimeout(this._torrentMetaTimeout);
      this._torrentMetaTimeout = null;
    }
  }
}
