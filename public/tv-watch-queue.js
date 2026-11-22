const prefix = 'personal-hub.tv.watch-pending.';

export class WatchSaveQueue {
  constructor(send, { storage, onChange = () => {} } = {}) {
    this.send = send;
    try { this.storage = storage ?? localStorage; } catch { this.storage = null; }
    this.onChange = onChange;
    this.entries = new Map();
    this.saving = false;
    this.error = '';
    this.timer = null;
    this.retryDelay = 2000;
    this.reload();
  }

  key(change) {
    return prefix + change.showId + '.' + change.episodeId;
  }

  reload() {
    try {
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const change = JSON.parse(this.storage.getItem(key));
        if (Number.isSafeInteger(change?.showId) && Number.isSafeInteger(change?.episodeId) &&
            Number.isInteger(change?.season) && typeof change?.watched === 'boolean' &&
            typeof change?.mutationId === 'string' && Number.isFinite(Date.parse(change?.watchedAt))) {
          this.entries.set(key, change);
        }
      }
    } catch {
      this.error = 'Keep this page open while watch progress saves.';
    }
  }

  enqueue(showId, season, episodes, watched) {
    for (const episodeId of episodes) {
      const change = { showId, season, episodeId, watched,
        mutationId: crypto.randomUUID(), watchedAt: new Date().toISOString() };
      const key = this.key(change);
      this.entries.set(key, change);
      try { this.storage.setItem(key, JSON.stringify(change)); }
      catch { this.error = 'Keep this page open while watch progress saves.'; }
    }
    this.onChange('queued');
    this.schedule(250);
  }

  project(item) {
    const changes = [...this.entries.values()].filter(change => change.showId === item.show.id);
    if (!changes.length) return item;
    const watched = new Map((item.watched || []).map(record => [record.episodeId, record]));
    const preferences = new Map((item.watchSeasons || []).map(record => [record.season, record]));
    for (const change of changes) {
      if (change.watched) {
        const previous = watched.get(change.episodeId);
        watched.set(change.episodeId, { showId: change.showId, season: change.season,
          episodeId: change.episodeId, watchedAt: previous?.watchedAt || change.watchedAt });
      } else watched.delete(change.episodeId);
      if (!preferences.has(change.season)) preferences.set(change.season, {
        showId: change.showId, season: change.season, queued: true, mode: 'release'
      });
    }
    return { ...item, watched: [...watched.values()], watchSeasons: [...preferences.values()] };
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  }

  async flush() {
    if (this.saving || !this.entries.size) return;
    clearTimeout(this.timer);
    const batch = [...this.entries.values()].slice(0, 100);
    this.saving = true;
    this.onChange('saving');
    try {
      await this.send(batch);
      for (const change of batch) {
        const key = this.key(change);
        if (this.entries.get(key)?.mutationId !== change.mutationId) continue;
        this.entries.delete(key);
        try {
          const stored = JSON.parse(this.storage.getItem(key));
          if (stored?.mutationId === change.mutationId) this.storage.removeItem(key);
          else if (stored) this.entries.set(key, stored);
        } catch {}
      }
      this.error = '';
      this.retryDelay = 2000;
      this.onChange('saved');
    } catch {
      this.error = 'Watch changes are waiting on this device. Retrying automatically.';
      this.onChange('failed');
      this.retryDelay = Math.min(this.retryDelay * 2, 30000);
    } finally {
      this.saving = false;
      if (this.entries.size) this.schedule(this.error ? this.retryDelay : 0);
    }
  }
}
