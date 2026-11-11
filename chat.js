/**
 * Chat and Notification Manager for CyTube Clone
 */

class ChatManager {
  constructor(options = {}) {
    this.messagesContainer = document.getElementById(options.messagesContainerId || 'chat-messages');
    this.usersContainer = document.getElementById(options.usersContainerId || 'users-list');
    this.inputElement = document.getElementById(options.inputId || 'chat-input');
    this.sendBtn = document.getElementById(options.sendBtnId || 'chat-send-btn');
    this.onSendMessage = options.onSendMessage || (() => {});

    this.soundEnabled = true;
    this.audioCtx = null;

    this.setupListeners();
  }

  setupListeners() {
    if (this.sendBtn && this.inputElement) {
      this.sendBtn.addEventListener('click', () => this.handleSend());
      this.inputElement.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          this.handleSend();
        }
      });
    }

    // Sound toggle
    const soundToggle = document.getElementById('chat-sound-toggle');
    if (soundToggle) {
      soundToggle.addEventListener('click', () => {
        this.soundEnabled = !this.soundEnabled;
        soundToggle.innerText = this.soundEnabled ? '🔔' : '🔕';
        soundToggle.title = this.soundEnabled ? 'Sound Enabled' : 'Sound Muted';
      });
    }
  }

  handleSend() {
    const text = this.inputElement.value.trim();
    if (!text) return;
    this.onSendMessage(text);
    this.inputElement.value = '';
    this.inputElement.focus();
  }

  playChime() {
    if (!this.soundEnabled) return;
    try {
      if (!this.audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContext();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, this.audioCtx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, this.audioCtx.currentTime + 0.1); // A5

      gain.gain.setValueAtTime(0.08, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.25);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.25);
    } catch (e) {
      // AudioContext blocked by autoplay policy before user gesture
    }
  }

  formatTime(unixTimestamp) {
    const date = new Date(unixTimestamp * 1000);
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  addMessage(msg, isHistory = false) {
    if (!this.messagesContainer) return;

    const div = document.createElement('div');
    div.className = 'chat-msg';

    const timeStr = this.formatTime(msg.timestamp || Date.now() / 1000);

    if (msg.is_system) {
      div.innerHTML = `
        <span class="chat-time">[${timeStr}]</span>
        <span class="chat-sys">${this.escapeHTML(msg.text)}</span>
      `;
    } else {
      let badgeHTML = '';
      if (msg.badge) {
        badgeHTML = `<span class="chat-badge">${this.escapeHTML(msg.badge)}</span>`;
      }

      div.innerHTML = `
        <span class="chat-time">[${timeStr}]</span>
        ${badgeHTML}
        <span class="chat-user">${this.escapeHTML(msg.username)}:</span>
        <span class="chat-text">${this.formatMessageText(msg.text)}</span>
      `;

      if (!isHistory) {
        this.playChime();
      }
    }

    this.messagesContainer.appendChild(div);
    this.scrollToBottom();
  }

  updateUsersList(users, leaderId) {
    if (!this.usersContainer) return;
    this.usersContainer.innerHTML = '';

    const countElem = document.getElementById('users-tab-count');
    if (countElem) {
      countElem.innerText = `(${users.length})`;
    }

    users.forEach(u => {
      const item = document.createElement('div');
      item.className = 'user-item';

      const isLeader = u.user_id === leaderId || u.is_leader;
      item.innerHTML = `
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <div style="width: 8px; height: 8px; border-radius: 50%; background: #10b981;"></div>
          <span style="font-weight: 500;">${this.escapeHTML(u.username)}</span>
        </div>
        ${isLeader ? '<span class="chat-badge">👑 DJ</span>' : ''}
      `;
      this.usersContainer.appendChild(item);
    });
  }

  scrollToBottom() {
    if (!this.messagesContainer) return;
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  formatMessageText(str) {
    const escaped = this.escapeHTML(str);
    // Linkify URLs
    const urlPattern = /(\b(https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gim;
    return escaped.replace(urlPattern, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color: #38bdf8; text-decoration: underline;">$1</a>');
  }
}
