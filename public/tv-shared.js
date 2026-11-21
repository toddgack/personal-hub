export class SharedTVList {
  constructor(fetcher = fetch) {
    this.fetcher = fetcher;
    this.rows = new Map();
    this.ready = false;
    this.version = -1;
  }

  async request(path, method = 'GET', body) {
    const response = await this.fetcher('/api/tv/' + path, {
      method, cache: 'no-store', signal: AbortSignal.timeout(20000),
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('The shared list could not connect. Try Sync list again.'); }
    if (Array.isArray(data.shows) && Number.isSafeInteger(data.version) && data.version >= this.version) {
      this.rows = new Map(data.shows.map(row => [row.id, row]));
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
    if (!this.ready) throw new Error('Sync the shared list before making changes.');
    return this.request('shows/' + item.show.id, removed ? 'DELETE' : 'PUT', {
      name: item.show.name, archived: Boolean(item.archived),
      revision: this.rows.get(item.show.id)?.revision || 0
    });
  }
}
