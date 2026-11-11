/**
 * Playlist and Queue Manager for CyTube Clone
 */

class PlaylistManager {
  constructor(options = {}) {
    this.container = document.getElementById(options.containerId || 'playlist-items');
    this.countElem = document.getElementById(options.countId || 'playlist-count');
    this.onRemoveItem = options.onRemoveItem || (() => {});
    this.onPlayItem = options.onPlayItem || (() => {});
  }

  render(playlist) {
    if (!this.container) return;
    this.container.innerHTML = '';

    if (this.countElem) {
      this.countElem.innerText = `(${playlist.length} items)`;
    }

    if (playlist.length === 0) {
      this.container.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 2rem; text-align: center; color: var(--text-muted); font-size: 0.9rem;">
          📭 The playlist is empty. Click "➕ Add to Queue" to queue a YouTube video or Magnet link!
        </div>
      `;
      return;
    }

    playlist.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'playlist-item';

      let thumbHTML = '';
      if (item.thumbnail) {
        thumbHTML = `<img src="${item.thumbnail}" class="playlist-thumb" alt="Thumbnail" />`;
      } else {
        const icon = item.type === 'torrent' ? '🧲' : (item.type === 'youtube' ? '▶️' : (item.type === 'tiktok' ? '🎵' : (item.type === 'twitter' ? '🐦' : '🎬')));
        thumbHTML = `<div class="playlist-thumb">${icon}</div>`;
      }

      card.innerHTML = `
        <span style="font-size: 0.8rem; font-weight: bold; color: var(--text-muted); width: 18px;">#${index + 1}</span>
        ${thumbHTML}
        <div class="playlist-info">
          <div class="playlist-item-title" title="${this.escapeHTML(item.title)}">${this.escapeHTML(item.title)}</div>
          <div class="playlist-item-meta">
            <span class="type-pill ${item.type}">${item.type.toUpperCase()}</span>
            <span>Added by ${this.escapeHTML(item.added_by || 'Anonymous')}</span>
          </div>
        </div>
        <div style="display: flex; gap: 0.35rem; align-items: center;">
          <button class="btn btn-success btn-sm btn-play-now" title="Play this video now" data-id="${item.id}">▶</button>
          <button class="btn btn-danger btn-sm btn-remove-item" title="Remove from queue" data-id="${item.id}">✕</button>
        </div>
      `;

      const playBtn = card.querySelector('.btn-play-now');
      if (playBtn) {
        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onPlayItem(item.id);
        });
      }

      const removeBtn = card.querySelector('.btn-remove-item');
      if (removeBtn) {
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.onRemoveItem(item.id);
        });
      }

      this.container.appendChild(card);
    });
  }

  escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
