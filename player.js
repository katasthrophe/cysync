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

    this.currentMedia = null;
    this.currentType = null; // 'youtube' | 'torrent' | 'url' | null

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

    // Initialize WebTorrent Client with tracker options
    if (typeof WebTorrent !== 'undefined') {
      try {
        this.torrentClient = new WebTorrent({
          tracker: {
            rtcConfig: {
              iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:global.stun.twilio.com:3478' }
              ]
            }
          }
        });
        console.log('WebTorrent client initialized successfully');
      } catch (e) {
        console.warn('WebTorrent init warning:', e);
      }
    }

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
      this.showYouTube();
      this.loadYouTube(mediaItem.source, initialTime, initialState);
    } else if (mediaItem.type === 'torrent') {
      this.hideYouTube();
      this.showTorrent();
      this.loadTorrent(mediaItem.source, initialTime, initialState);
    } else if (mediaItem.type === 'url') {
      this.hideYouTube();
      this.showTorrent();
      this.loadDirectUrl(mediaItem.source, initialTime, initialState);
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

  loadTorrent(magnetURI, initialTime = 0, initialState = 'playing') {
    if (!this.torrentClient) {
      if (typeof WebTorrent !== 'undefined') {
        this.torrentClient = new WebTorrent();
      } else {
        alert('La librería WebTorrent no está disponible.');
        return;
      }
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.hudElement) {
      this.hudElement.style.display = 'flex';
      this.updateHud({ peers: 0, speed: 0, progress: 0, status: 'Conectando a trackers WebRTC...' });
    }

    // Inject verified active WebTorrent trackers into magnet if missing
    let finalMagnet = magnetURI;
    const activeTrackers = [
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.webtorrent.dev',
      'wss://tracker.files.fm:7073/announce'
    ];

    for (const tracker of activeTrackers) {
      if (!finalMagnet.includes(encodeURIComponent(tracker)) && !finalMagnet.includes(tracker)) {
        finalMagnet += `&tr=${encodeURIComponent(tracker)}`;
      }
    }

    // Check if this magnet is already added in the client to avoid duplicate error
    let existingTorrent = null;
    try {
      existingTorrent = this.torrentClient.get(finalMagnet);
    } catch (e) {}

    const onTorrentReady = (torrent) => {
      this.currentTorrent = torrent;
      console.log('Torrent metadata ready:', torrent.name, 'files:', torrent.files.length);

      // Select largest or best video file
      const videoFiles = torrent.files.filter(f => /\.(mp4|m4v|webm|mkv|mov|ogv)$/i.test(f.name));
      const videoFile = videoFiles.sort((a, b) => b.length - a.length)[0] || torrent.files[0];

      if (videoFile && this.torrentVideo) {
        this.updateHud({
          name: videoFile.name,
          status: 'Buffering & Streaming video...',
          peers: torrent.numPeers
        });

        // Use WebTorrent's renderTo
        videoFile.renderTo(this.torrentVideo, {
          autoplay: (initialState === 'playing'),
          controls: true
        }, (err, elem) => {
          if (err) {
            console.error('Error in videoFile.renderTo:', err);
            this.updateHud({ status: `Error al decodificar: ${err.message}` });
            return;
          }

          console.log('Torrent video stream attached successfully');
          this.isApplyingSync = true;
          this.syncCooldownUntil = Date.now() + 1500;

          if (initialTime > 0) {
            try { this.torrentVideo.currentTime = initialTime; } catch (e) {}
          }

          if (initialState === 'playing') {
            this.torrentVideo.play().catch(playErr => {
              console.warn('Autoplay prevented by browser gesture policy:', playErr);
              if (this.playOverlay) {
                this.playOverlay.style.display = 'flex';
              }
            });
          }
          setTimeout(() => { this.isApplyingSync = false; }, 1200);
        });
      }
    };

    if (existingTorrent && existingTorrent.ready) {
      onTorrentReady(existingTorrent);
    } else {
      // Destroy any other active torrents to keep bandwidth free
      this.torrentClient.torrents.forEach(t => {
        if (!existingTorrent || t !== existingTorrent) {
          try { t.destroy(); } catch (e) {}
        }
      });

      try {
        const torrent = existingTorrent || this.torrentClient.add(finalMagnet);
        this.currentTorrent = torrent;

        torrent.on('wire', () => {
          this.updateHud({
            peers: torrent.numPeers,
            status: torrent.ready ? 'Descargando...' : 'Obteniendo metadatos...'
          });
        });

        torrent.on('error', (err) => {
          console.error('Torrent error:', err);
          this.updateHud({ status: `Error en torrent: ${err.message}` });
        });

        torrent.on('warning', (warn) => {
          console.warn('Torrent warning:', warn);
        });

        if (torrent.ready) {
          onTorrentReady(torrent);
        } else {
          torrent.once('ready', () => {
            onTorrentReady(torrent);
          });
        }
      } catch (err) {
        console.error('Failed to add magnet link:', err);
        this.updateHud({ status: `Error: ${err.message}` });
      }
    }

    // Monitor statistics every 500ms
    let zeroPeerSeconds = 0;
    this.statsInterval = setInterval(() => {
      if (!this.currentTorrent) return;

      const peers = this.currentTorrent.numPeers || 0;
      const speed = this.currentTorrent.downloadSpeed || 0;
      const progress = ((this.currentTorrent.progress || 0) * 100).toFixed(1);

      if (peers === 0) {
        zeroPeerSeconds += 0.5;
      } else {
        zeroPeerSeconds = 0;
      }

      let statusText = 'Conectando a enjambre...';
      if (this.currentTorrent.ready) {
        statusText = peers > 0 ? 'Transmitiendo en vivo' : 'Buscando peers WebRTC...';
      } else {
        statusText = 'Descargando metadatos del torrent...';
      }

      // If after 15 seconds no WebRTC peers are found, inform the user clearly
      if (zeroPeerSeconds > 15 && peers === 0) {
        statusText = '⚠️ 0 peers WebRTC. Se requieren seeders con WebTorrent/WebRTC para streaming web.';
      }

      this.updateHud({
        peers: peers,
        speed: speed,
        progress: progress,
        status: statusText
      });
    }, 500);
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
    if (this.currentTorrent) {
      try { this.currentTorrent.destroy(); } catch (e) {}
      this.currentTorrent = null;
    }
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
  }
}
