function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function validShow(value) {
  return Number.isSafeInteger(value?.id) && value.id > 0 &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 300 &&
    typeof value.archived === 'boolean';
}

export class HouseholdTVList {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS shows (id INTEGER PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS list_state (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO list_state (id, version) VALUES (1, 0)');
  }

  snapshot() {
    const rows = this.sql.exec('SELECT id, name, archived, removed, revision FROM shows ORDER BY id').toArray();
    return rows.map(row => ({ ...row, archived: Boolean(row.archived), removed: Boolean(row.removed) }));
  }

  response(status = 200, error) {
    const version = this.sql.exec('SELECT version FROM list_state WHERE id = 1').toArray()[0].version;
    return json({ shows: this.snapshot(), version, ...(error ? { error } : {}) }, status);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/tv/list') return this.response();
    if (request.method === 'POST' && url.pathname === '/api/tv/migrate') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'Invalid show list.' }, 400); }
      if (!Array.isArray(body.shows) || body.shows.length > 1000 || !body.shows.every(validShow)) return json({ error: 'Invalid show list.' }, 400);
      this.storage.transactionSync(() => {
        for (const show of body.shows) {
          // Existing rows include removals, so an old phone cannot restore a removed show.
          this.sql.exec('INSERT OR IGNORE INTO shows (id, name, archived) VALUES (?, ?, ?)', show.id, show.name, Number(show.archived));
        }
        this.sql.exec('UPDATE list_state SET version = version + 1 WHERE id = 1');
      });
      return this.response();
    }
    const match = url.pathname.match(/^\/api\/tv\/shows\/(\d+)$/);
    if (!match || !['PUT', 'DELETE'].includes(request.method)) return json({ error: 'Not found.' }, 404);
    const id = Number(match[1]);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid change.' }, 400); }
    if (!Number.isSafeInteger(body.revision) || body.revision < 0 ||
        !validShow({ id, name: body.name, archived: body.archived })) return json({ error: 'Invalid change.' }, 400);
    const current = this.sql.exec('SELECT revision FROM shows WHERE id = ?', id).toArray()[0];
    if ((current?.revision || 0) !== body.revision) return this.response(409, 'This show changed on another device. The latest list has been loaded. Try your change again.');
    const removed = request.method === 'DELETE';
    this.sql.exec(
      'INSERT INTO shows (id, name, archived, removed, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, archived=excluded.archived, removed=excluded.removed, revision=excluded.revision',
      id, body.name, Number(body.archived), Number(removed), body.revision + 1
    );
    this.sql.exec('UPDATE list_state SET version = version + 1 WHERE id = 1');
    return this.response();
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/tv/')) return env.ASSETS.fetch(request);
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405);
    if (request.method !== 'GET') {
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return json({ error: 'Open the TV guide to edit the list.' }, 403);
      if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'JSON required.' }, 415);
      if (Number(request.headers.get('Content-Length')) > 100000) return json({ error: 'Request too large.' }, 413);
    }
    try {
      const id = env.TV_LIST.idFromName('household');
      return await env.TV_LIST.get(id).fetch(request);
    } catch {
      return json({ error: 'The shared list is temporarily unavailable. The page will try again automatically.' }, 503);
    }
  }
};
