/**
 * CyTube Clone - Main Application Coordinator
 */

document.addEventListener('DOMContentLoaded', () => {
  // Extract room ID from URL path /r/{roomId} or query param or default
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  let roomId = 'default';
  if (pathParts.length >= 2 && pathParts[0] === 'r') {
    roomId = pathParts[1];
  } else {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('room')) {
      roomId = urlParams.get('room');
    }
  }

  // Update room label in header
  const roomLabel = document.getElementById('room-name-display');
  if (roomLabel) roomLabel.innerText = `Room: ${roomId}`;

  // Local user state
  let currentUsername = localStorage.getItem('cytube_username') || `User_${Math.floor(1000 + Math.random() * 9000)}`;
  let myUserId = null;
  let isLeader = false;
  let lockControls = false;
  let serverSyncState = {
    state: 'paused',
    currentTime: 0,
    lastUpdate: Date.now() / 1000,
    playbackRate: 1.0
  };

  // UI Elements
  const statusDot = document.getElementById('connection-status-dot');
  const playPauseBtn = document.getElementById('btn-play-pause');
  const skipBtn = document.getElementById('btn-skip');
  const voteSkipBtn = document.getElementById('btn-voteskip');
  const syncBtn = document.getElementById('btn-sync');
  const claimDjBtn = document.getElementById('btn-claim-dj');
  const toggleLockBtn = document.getElementById('btn-toggle-lock');
  const shareBtn = document.getElementById('btn-share-room');
  const changeUserBtn = document.getElementById('btn-change-username');
  const usernameDisplay = document.getElementById('username-display');

  // Media info elements
  const mediaTitleElem = document.getElementById('current-media-title');
  const mediaTypePill = document.getElementById('current-media-type');
  const mediaAddedBy = document.getElementById('current-media-added-by');

  // Time & progress
  const timeDisplay = document.getElementById('time-display');
  const progressBar = document.getElementById('playback-progress');

  if (usernameDisplay) {
    usernameDisplay.innerText = currentUsername;
  }

  // Initialize Sub-Managers
  let ws = null;
  let player = null;
  let chatManager = null;
  let playlistManager = null;

  // Initialize Chat
  chatManager = new ChatManager({
    onSendMessage: (text) => {
      sendWS('chat', { text });
    }
  });

  // Initialize Player
  player = new UniversalPlayer({
    ytContainerId: 'yt-player-container',
    torrentVideoId: 'torrent-player',
    hudElementId: 'torrent-hud',
    onPlaybackChange: (action, time) => {
      sendWS('playback', { action, time });
    },
    onMediaEnded: () => {
      sendWS('skip', {});
    },
    onPlayerError: (msg) => {
      chatManager.addMessage({
        is_system: true,
        text: msg,
        timestamp: Date.now() / 1000
      });
    }
  });

  // Initialize Playlist
  playlistManager = new PlaylistManager({
    onRemoveItem: (itemId) => {
      sendWS('remove_playlist_item', { item_id: itemId });
    },
    onPlayItem: (itemId) => {
      sendWS('play_item', { item_id: itemId });
    }
  });

  // WebSocket Connection
  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws/${roomId}`;

    if (statusDot) {
      statusDot.className = 'status-dot';
      statusDot.title = 'Connecting...';
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('Connected to room WebSocket:', roomId);
      if (statusDot) {
        statusDot.className = 'status-dot connected';
        statusDot.title = 'Connected';
      }
      sendWS('set_username', { username: currentUsername });
    };

    ws.onclose = () => {
      console.warn('WebSocket disconnected. Retrying in 3 seconds...');
      if (statusDot) {
        statusDot.className = 'status-dot disconnected';
        statusDot.title = 'Disconnected (Reconnecting...)';
      }
      setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      ws.close();
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleServerEvent(payload.type, payload.data);
      } catch (err) {
        console.error('Failed to parse WS message:', err);
      }
    };
  }

  function sendWS(type, data = {}) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, data }));
    }
  }

  function handleServerEvent(type, data) {
    switch (type) {
      case 'init':
        handleInitState(data);
        break;

      case 'user_joined':
      case 'user_left':
      case 'user_renamed':
      case 'leader_changed':
        if (data.users) {
          chatManager.updateUsersList(data.users, data.leader_id);
        }
        if (data.leader_id) {
          isLeader = (data.leader_id === myUserId);
          updateLeaderUI();
        }
        break;

      case 'chat_message':
        chatManager.addMessage(data);
        break;

      case 'playback_update':
        applyServerPlayback(data.playback);
        break;

      case 'playback_rejected':
        chatManager.addMessage({
          id: 'rej_' + Date.now(),
          is_system: true,
          text: data.message || '🔒 Acción rechazada: Solo el Host puede controlar la reproducción.',
          timestamp: Date.now() / 1000
        });
        if (data.playback) {
          applyServerPlayback(data.playback);
        }
        break;

      case 'lock_controls_changed':
        lockControls = Boolean(data.lock_controls);
        updateLeaderUI();
        break;

      case 'media_changed':
        handleMediaChanged(data.media, data.playback, data.playlist);
        break;

      case 'playlist_updated':
        if (playlistManager && data.playlist) {
          playlistManager.render(data.playlist);
        }
        break;

      case 'voteskip_update':
        if (voteSkipBtn) {
          voteSkipBtn.innerText = `🗳️ Vote Skip (${data.votes}/${data.needed})`;
        }
        break;
    }
  }

  function handleInitState(state) {
    console.log('Room init state received:', state);

    if (state.users) {
      const me = state.users.find(u => u.username === currentUsername);
      if (me) myUserId = me.user_id;
      chatManager.updateUsersList(state.users, state.leader_id);
    }

    isLeader = (state.leader_id === myUserId);
    lockControls = Boolean(state.lock_controls);
    updateLeaderUI();

    if (state.chat_history && state.chat_history.length > 0) {
      state.chat_history.forEach(m => chatManager.addMessage(m, true));
    }

    if (playlistManager && state.playlist) {
      playlistManager.render(state.playlist);
    }

    if (state.current_media) {
      handleMediaChanged(state.current_media, state.playback, state.playlist);
    } else {
      player.loadMedia(null);
      updateMediaInfoUI(null);
    }

    if (voteSkipBtn && state.voteskips_count !== undefined) {
      voteSkipBtn.innerText = `🗳️ Vote Skip (${state.voteskips_count}/${state.voteskips_needed})`;
    }
  }

  function handleMediaChanged(media, playback, playlist) {
    updateMediaInfoUI(media);

    if (playlist && playlistManager) {
      playlistManager.render(playlist);
    }

    if (playback) {
      serverSyncState = {
        state: playback.state,
        currentTime: playback.current_time,
        lastUpdate: playback.last_update,
        playbackRate: playback.playback_rate || 1.0
      };
    }

    const currentProjectedTime = calculateProjectedTime();
    player.loadMedia(media, currentProjectedTime, serverSyncState.state);
    updatePlayPauseButton(serverSyncState.state);
  }

  function applyServerPlayback(playback) {
    if (!playback) return;
    serverSyncState = {
      state: playback.state,
      currentTime: playback.current_time,
      lastUpdate: playback.last_update,
      playbackRate: playback.playback_rate || 1.0
    };

    const targetTime = calculateProjectedTime();
    player.sync(targetTime, serverSyncState.state);
    updatePlayPauseButton(serverSyncState.state);
  }

  function calculateProjectedTime() {
    if (serverSyncState.state === 'playing') {
      const elapsed = Math.max(0, (Date.now() / 1000) - serverSyncState.lastUpdate);
      return serverSyncState.currentTime + (elapsed * serverSyncState.playbackRate);
    }
    return serverSyncState.currentTime;
  }

  function updatePlayPauseButton(state) {
    if (!playPauseBtn) return;
    if (state === 'playing') {
      playPauseBtn.innerHTML = '⏸️ Pause';
    } else {
      playPauseBtn.innerHTML = '▶️ Play';
    }
  }

  function updateLeaderUI() {
    if (claimDjBtn) {
      claimDjBtn.innerHTML = isLeader ? '👑 Eres el Host' : '👑 Claim DJ';
      claimDjBtn.className = isLeader ? 'btn btn-primary' : 'btn';
    }
    if (toggleLockBtn) {
      if (isLeader) {
        toggleLockBtn.style.display = 'inline-flex';
        toggleLockBtn.innerHTML = lockControls ? '🔒 Modo: Solo Host' : '🌐 Modo: Todos';
        toggleLockBtn.className = lockControls ? 'btn btn-danger' : 'btn';
        toggleLockBtn.title = lockControls ? 'Modo Estricto: Solo tú puedes pausar/reproducir (clic para desbloquear)' : 'Modo Libre: Todos pueden pausar (clic para activar Solo Host)';
      } else {
        toggleLockBtn.style.display = lockControls ? 'inline-flex' : 'none';
        toggleLockBtn.innerHTML = lockControls ? '🔒 Modo: Solo Host' : '';
        toggleLockBtn.className = 'btn';
        toggleLockBtn.title = 'El Host ha restringido los controles a su propia cuenta.';
      }
    }
  }

  function updateMediaInfoUI(media) {
    if (!media) {
      if (mediaTitleElem) mediaTitleElem.innerText = 'No media currently loaded';
      if (mediaTypePill) {
        mediaTypePill.innerText = 'OFFLINE';
        mediaTypePill.className = 'type-pill';
      }
      if (mediaAddedBy) mediaAddedBy.innerText = 'Waiting for queue';
      return;
    }

    if (mediaTitleElem) mediaTitleElem.innerText = media.title;
    if (mediaTypePill) {
      mediaTypePill.innerText = media.type.toUpperCase();
      mediaTypePill.className = `type-pill ${media.type}`;
    }
    if (mediaAddedBy) mediaAddedBy.innerText = `Added by ${media.added_by || 'Anonymous'}`;
  }

  // Periodic Sync Engine (checks drift every 1.5 seconds)
  setInterval(() => {
    if (!player.currentMedia) return;

    if (serverSyncState.state === 'playing') {
      // Host sends periodic heartbeat so all viewers stay 100% frame-accurate
      if (isLeader) {
        const t = player.getCurrentTime();
        if (typeof t === 'number' && !isNaN(t) && t > 0) {
          sendWS('playback_heartbeat', { time: t });
        }
      }

      const projected = calculateProjectedTime();
      const current = player.getCurrentTime();
      const drift = Math.abs(current - projected);

      if (drift > 2.0) {
        player.sync(projected, 'playing');
      }
    } else if (serverSyncState.state === 'paused') {
      // Room is paused: enforce strictly on all clients!
      const current = player.getCurrentTime();
      const drift = Math.abs(current - serverSyncState.currentTime);
      if (drift > 0.8) {
        player.seek(serverSyncState.currentTime);
      }
      player.pause();
    }

    updateProgressUI();
  }, 1000);

  function updateProgressUI() {
    const cur = player.getCurrentTime();
    const dur = player.getDuration();

    if (timeDisplay) {
      timeDisplay.innerText = `${formatSeconds(cur)} / ${formatSeconds(dur)}`;
    }

    if (progressBar && dur > 0) {
      progressBar.value = (cur / dur) * 100;
    }
  }

  function formatSeconds(sec) {
    if (!sec || isNaN(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Control Buttons Event Listeners
  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', () => {
      const curTime = player.getCurrentTime();
      const nextAction = serverSyncState.state === 'playing' ? 'pause' : 'play';
      if (nextAction === 'play') {
        player.play();
      } else {
        player.pause();
      }
      sendWS('playback', { action: nextAction, time: curTime });
    });
  }

  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      sendWS('skip', {});
    });
  }

  if (voteSkipBtn) {
    voteSkipBtn.addEventListener('click', () => {
      sendWS('vote_skip', {});
    });
  }

  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      const targetTime = calculateProjectedTime();
      player.sync(targetTime, serverSyncState.state);
      syncBtn.innerText = '⚡ Synced!';
      setTimeout(() => { syncBtn.innerText = '⚡ Force Sync'; }, 1500);
    });
  }

  if (claimDjBtn) {
    claimDjBtn.addEventListener('click', () => {
      sendWS('claim_leader', {});
    });
  }

  if (toggleLockBtn) {
    toggleLockBtn.addEventListener('click', () => {
      if (!isLeader) {
        alert('Solo el Host (👑) puede cambiar el modo de control de la sala.');
        return;
      }
      sendWS('toggle_lock', { locked: !lockControls });
    });
  }

  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(window.location.href).then(() => {
        shareBtn.innerText = '✅ Link Copied!';
        setTimeout(() => { shareBtn.innerText = '🔗 Share Room'; }, 2000);
      }).catch(() => {
        alert(`Room Link: ${window.location.href}`);
      });
    });
  }

  if (progressBar) {
    progressBar.addEventListener('input', (e) => {
      const percent = e.target.value;
      const dur = player.getDuration();
      if (dur > 0) {
        const seekTime = (percent / 100) * dur;
        player.seek(seekTime);
        sendWS('playback', { action: 'seek', time: seekTime });
      }
    });
  }

  // Tabs (Chat vs Users)
  const tabChat = document.getElementById('tab-chat-btn');
  const tabUsers = document.getElementById('tab-users-btn');
  const panelChat = document.getElementById('panel-chat');
  const panelUsers = document.getElementById('panel-users');

  if (tabChat && tabUsers && panelChat && panelUsers) {
    tabChat.addEventListener('click', () => {
      tabChat.classList.add('active');
      tabUsers.classList.remove('active');
      panelChat.style.display = 'flex';
      panelUsers.style.display = 'none';
    });

    tabUsers.addEventListener('click', () => {
      tabUsers.classList.add('active');
      tabChat.classList.remove('active');
      panelChat.style.display = 'none';
      panelUsers.style.display = 'flex';
    });
  }

  // Add Media Modal
  const addModal = document.getElementById('add-media-modal');
  const openAddModalBtn = document.getElementById('btn-open-add-modal');
  const closeAddModalBtn = document.getElementById('btn-close-add-modal');
  const mediaInput = document.getElementById('media-url-input');
  const mediaTitleInput = document.getElementById('media-title-input');
  const submitAddQueueBtn = document.getElementById('btn-submit-queue');
  const submitPlayNowBtn = document.getElementById('btn-submit-playnow');

  function openAddModal() {
    if (addModal) {
      addModal.classList.add('active');
      if (mediaInput) mediaInput.focus();
    }
  }

  function closeAddModal() {
    if (addModal) addModal.classList.remove('active');
  }

  if (openAddModalBtn) openAddModalBtn.addEventListener('click', openAddModal);
  if (closeAddModalBtn) closeAddModalBtn.addEventListener('click', closeAddModal);

  function handleAddMedia(playNow = false) {
    const source = mediaInput.value.trim();
    const title = mediaTitleInput.value.trim();
    if (!source) {
      alert('Please enter a YouTube URL, video ID, or Magnet link');
      return;
    }

    sendWS('add_media', {
      source,
      title: title || null,
      play_now: playNow
    });

    mediaInput.value = '';
    mediaTitleInput.value = '';
    closeAddModal();
  }

  if (submitAddQueueBtn) {
    submitAddQueueBtn.addEventListener('click', () => handleAddMedia(false));
  }
  if (submitPlayNowBtn) {
    submitPlayNowBtn.addEventListener('click', () => handleAddMedia(true));
  }

  // Username Change
  if (changeUserBtn) {
    changeUserBtn.addEventListener('click', () => {
      const newName = prompt('Enter your new username:', currentUsername);
      if (newName && newName.trim() && newName.trim() !== currentUsername) {
        currentUsername = newName.trim().substring(0, 24);
        localStorage.setItem('cytube_username', currentUsername);
        if (usernameDisplay) usernameDisplay.innerText = currentUsername;
        sendWS('set_username', { username: currentUsername });
      }
    });
  }

  // Connect WebSocket
  connectWebSocket();
});
