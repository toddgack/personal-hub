export class SharedTVList {
  constructor(fetcher = fetch) {
    this.fetcher = fetcher;
    this.rows = new Map();
    this.ready = false;
    this.version = -1;
    this.watchSeasons = [];
    this.watched = [];
  }

  async request(path, method = 'GET', body) {
    // Native browser fetch must not receive a SharedTVList instance as its receiver.
    const fetcher = this.fetcher;
    const response = await fetcher('/api/tv/' + path, {
      method, cache: 'no-store', signal: AbortSignal.timeout(20000),
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('Your shared shows could not load. The page will try again automatically.'); }
    if (Array.isArray(data.shows) && Number.isSafeInteger(data.version) && data.version >= this.version) {
      this.rows = new Map(data.shows.map(row => [row.id, row]));
      this.watchSeasons = data.watchSeasons || [];
      this.watched = data.watched || [];
      this.version = data.version;
      this.ready = true;
    }
    if (!response.ok) throw new Error(data.error || 'The shared list could not sync. Try again.');
    if (!Array.isArray(data.shows)) throw new Error('The shared list could not be read. Try again.');
    return this.members();
  }

  members() {
    return [...this.rows.values()].filter(row => !row.removed);
  }

  async connect(localItems) {
    return this.request('migrate', 'POST', {
      shows: localItems.map(item => ({ id: item.show.id, name: item.show.name, archived: Boolean(item.archived) }))
    });
  }

  async pull() {
    return this.request('list');
  }

  async change(item, removed = false) {
    if (!this.ready) throw new Error('Your shared shows are still loading. Please try adding the show again in a moment.');
    return this.request('shows/' + item.show.id, removed ? 'DELETE' : 'PUT', {
      name: item.show.name, archived: Boolean(item.archived),
      revision: this.rows.get(item.show.id)?.revision || 0
    });
  }

  async season(showId, season, queued, mode) {
    if (!this.ready) throw new Error('Your shared shows are still loading. Try again in a moment.');
    const current = this.watchSeasons.find(row => row.showId === showId && row.season === season);
    return this.request('season', 'POST', { showId, season, queued, mode, revision: current?.revision || 0 });
  }

  async watch(showId, season, episodes, watched) {
    if (!this.ready) throw new Error('Your shared shows are still loading. Try again in a moment.');
    return this.request('watch', 'POST', { showId, season, episodes, watched });
  }
}
