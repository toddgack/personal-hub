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
    this.sql.exec("CREATE TABLE IF NOT EXISTS watch_seasons (show_id INTEGER NOT NULL, season INTEGER NOT NULL, queued INTEGER NOT NULL DEFAULT 1, mode TEXT NOT NULL DEFAULT 'release', revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (show_id, season))");
    this.sql.exec('CREATE TABLE IF NOT EXISTS watched_episodes (show_id INTEGER NOT NULL, episode_id INTEGER NOT NULL, season INTEGER NOT NULL, watched_at TEXT, PRIMARY KEY (show_id, episode_id))');
  }

  snapshot() {
    const rows = this.sql.exec('SELECT id, name, archived, removed, revision FROM shows ORDER BY id').toArray();
    return rows.map(row => ({ ...row, archived: Boolean(row.archived), removed: Boolean(row.removed) }));
  }

  response(status = 200, error) {
    const version = this.sql.exec('SELECT version FROM list_state WHERE id = 1').toArray()[0].version;
    const watchSeasons = this.sql.exec('SELECT show_id AS showId, season, queued, mode, revision FROM watch_seasons').toArray().map(row => ({ ...row, queued: Boolean(row.queued) }));
    const watched = this.sql.exec('SELECT show_id AS showId, episode_id AS episodeId, season, watched_at AS watchedAt FROM watched_episodes WHERE watched_at IS NOT NULL').toArray();
    return json({ shows: this.snapshot(), watchSeasons, watched, version, ...(error ? { error } : {}) }, status);
  }

  async watchChange(request, path) {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'Invalid watch update.' }, 400); }
    if (!Number.isSafeInteger(body.showId) || body.showId <= 0 || !Number.isSafeInteger(body.season) || body.season < 0) return json({ error: 'Choose a valid show and season.' }, 400);
    const show = this.sql.exec('SELECT id FROM shows WHERE id = ? AND removed = 0', body.showId).toArray()[0];
    if (!show) return json({ error: 'This show is no longer in your guide.' }, 404);
    if (path === '/api/tv/season') {
      if (!['release', 'binge'].includes(body.mode) || typeof body.queued !== 'boolean' || !Number.isSafeInteger(body.revision) || body.revision < 0) return json({ error: 'Invalid season preference.' }, 400);
      const current = this.sql.exec('SELECT revision FROM watch_seasons WHERE show_id = ? AND season = ?', body.showId, body.season).toArray()[0];
      if ((current?.revision || 0) !== body.revision) return this.response(409, 'This season changed on another device. The latest progress has loaded. Try again.');
      this.sql.exec('INSERT INTO watch_seasons (show_id, season, queued, mode, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(show_id, season) DO UPDATE SET queued=excluded.queued, mode=excluded.mode, revision=excluded.revision', body.showId, body.season, Number(body.queued), body.mode, body.revision + 1);
      this.sql.exec('UPDATE list_state SET version = version + 1 WHERE id = 1');
      return this.response();
    }
    if (typeof body.watched !== 'boolean' || !Array.isArray(body.episodes) || !body.episodes.length || body.episodes.length > 1000 || !body.episodes.every(id => Number.isSafeInteger(id) && id > 0)) return json({ error: 'Choose valid episodes to update.' }, 400);
    const watchedAt = new Date().toISOString();
    this.storage.transactionSync(() => {
      this.sql.exec("INSERT OR IGNORE INTO watch_seasons (show_id, season, queued, mode) VALUES (?, ?, 1, 'release')", body.showId, body.season);
      for (const episodeId of new Set(body.episodes)) {
        if (body.watched) {
          this.sql.exec('INSERT INTO watched_episodes (show_id, episode_id, season, watched_at) VALUES (?, ?, ?, ?) ON CONFLICT(show_id, episode_id) DO UPDATE SET watched_at=COALESCE(watched_episodes.watched_at, excluded.watched_at)', body.showId, episodeId, body.season, watchedAt);
        } else {
          this.sql.exec('UPDATE watched_episodes SET watched_at = NULL WHERE show_id = ? AND episode_id = ?', body.showId, episodeId);
        }
      }
      this.sql.exec('UPDATE list_state SET version = version + 1 WHERE id = 1');
    });
    return this.response();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/api/tv/list') return this.response();
    if (request.method === 'POST' && ['/api/tv/season', '/api/tv/watch'].includes(url.pathname)) return this.watchChange(request, url.pathname);
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
