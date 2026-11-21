export const ZONE = 'America/Phoenix';
export const DAY = 86400000;
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));

export function localDay(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(value));
}

export function addDays(day, count) {
  return new Date(Date.parse(day + 'T12:00:00Z') + count * DAY).toISOString().slice(0, 10);
}

export function weekStart(day) {
  return addDays(day, -new Date(day + 'T12:00:00Z').getUTCDay());
}

export function dayDifference(first, last) {
  return Math.round((Date.parse(last + 'T12:00:00Z') - Date.parse(first + 'T12:00:00Z')) / DAY);
}

export function timed(episode) {
  return Boolean(episode.airtime && episode.airstamp && Number.isFinite(Date.parse(episode.airstamp)));
}

export function episodeDay(episode) {
  if (timed(episode)) return localDay(episode.airstamp);
  return validDay(episode.airdate) ? episode.airdate : null;
}

export function episodeTime(episode) {
  if (!timed(episode)) return 'Time TBA';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE, hour: 'numeric', minute: '2-digit'
  }).format(new Date(episode.airstamp));
}

export function episodeCode(episode) {
  const season = episode.season ?? '?';
  return episode.number == null ? 'Season ' + season + ' · Special' : 'S' + season + ' · E' + episode.number;
}

export function sortedEpisodes(episodes = []) {
  return [...episodes].sort((a, b) => {
    const first = episodeDay(a) || '9999';
    const second = episodeDay(b) || '9999';
    return first.localeCompare(second) || (a.airstamp || '').localeCompare(b.airstamp || '') || a.id - b.id;
  });
}

export function seasonSummary(item, number) {
  const season = item.seasons.find(value => value.number === number);
  const episodes = sortedEpisodes(item.episodes.filter(value => value.season === number));
  const regular = episodes.filter(value => value.number != null);
  const dated = regular.filter(episodeDay);
  const first = episodeDay(regular.find(value => value.number === 1) || {}) || season?.premiereDate || episodeDay(dated[0] || {});
  const orderedFinal = season?.episodeOrder > 0 && regular.find(value => value.number === season.episodeOrder);
  const listedFinal = dated.find(value => value.airdate === season?.endDate);
  const final = (orderedFinal && episodeDay(orderedFinal)) || episodeDay(listedFinal || {}) || season?.endDate || null;
  return { number, season, episodes, first, final, lastListed: episodeDay(dated.at(-1) || {}) };
}

export function showState(item, today = localDay()) {
  if (item.archived) return { group: 'Past', label: 'Moved to Past', next: null };
  const episodes = sortedEpisodes(item.episodes);
  const future = episodes.filter(value => episodeDay(value) && episodeDay(value) >= today);
  const next = future[0] || null;
  const numbers = [...new Set([...item.seasons.map(value => value.number), ...episodes.map(value => value.season)])].sort((a, b) => b - a);
  const current = numbers.map(number => seasonSummary(item, number)).find(season =>
    season.first && season.first <= today &&
    ((season.final && season.final >= today) || season.episodes.some(episode => episodeDay(episode) >= today))
  );
  if (current) return { group: 'Active', label: 'Season ' + current.number + ' releasing', next };
  if (next || item.seasons.some(value => value.premiereDate > today)) {
    return { group: 'Upcoming', label: 'Return scheduled', next };
  }
  if (item.show.status === 'Ended') return { group: 'Past', label: 'Series ended', next: null };
  return { group: 'Upcoming', label: 'Awaiting dates', next: null };
}

export function released(episode, today = localDay(), now = Date.now()) {
  const day = episodeDay(episode);
  return Boolean(day && day <= today && (!timed(episode) || Date.parse(episode.airstamp) <= now));
}

export function defaultSeason(item, today = localDay()) {
  const numbers = [...new Set([...item.seasons.map(season => season.number), ...item.episodes.map(episode => episode.season)])].sort((a, b) => b - a);
  return numbers.find(number => {
    const first = seasonSummary(item, number).first;
    return first && first <= today;
  }) ?? numbers.at(-1);
}

export function seasonProgress(item, number, today = localDay(), now = Date.now()) {
  const summary = seasonSummary(item, number);
  const preference = (item.watchSeasons || []).find(row => row.season === number);
  const implicit = !(item.watchSeasons || []).length && !item.archived && number === defaultSeason(item, today);
  const queued = preference ? preference.queued : implicit;
  const mode = preference?.mode || 'release';
  const records = (item.watched || []).filter(row => row.season === number);
  const watchedIds = new Set(records.map(row => row.episodeId));
  const regular = summary.episodes.filter(episode => episode.number != null);
  const available = regular.filter(episode => released(episode, today, now));
  const remaining = available.filter(episode => !watchedIds.has(episode.id));
  const total = summary.season?.episodeOrder || regular.length;
  const laterSeasonStarted = item.seasons.some(season => season.number > number && season.premiereDate && season.premiereDate <= today);
  const seasonEnded = (summary.final && summary.final <= today) || item.show.status === 'Ended' || laterSeasonStarted;
  const finished = Boolean(seasonEnded && regular.length > 0 &&
    regular.length >= total && regular.every(episode => released(episode, today, now)));
  const complete = finished && regular.every(episode => watchedIds.has(episode.id));
  const count = regular.filter(episode => watchedIds.has(episode.id)).length;
  const lastWatched = records.map(row => row.watchedAt).sort().at(-1) || null;
  let label = 'Awaiting release';
  if (complete) label = 'Season watched';
  else if (mode === 'binge') label = finished ? 'Ready to binge' : 'Waiting for the finale';
  else if (remaining.length) label = count ? 'Continue watching' : 'Ready to watch';
  else if (count) label = 'Caught up';
  return { ...summary, queued, mode, watchedIds, available, remaining, total, count, finished, complete, lastWatched, label };
}

export function queuedSeasons(item, today = localDay(), now = Date.now()) {
  const preferences = item.watchSeasons || [];
  const numbers = preferences.length ? preferences.filter(row => row.queued).map(row => row.season) :
    item.archived ? [] : [defaultSeason(item, today)].filter(number => number !== undefined);
  return numbers.map(number => ({ item, number, progress: seasonProgress(item, number, today, now) })).filter(entry => !entry.progress.complete);
}

export function releaseGaps(item) {
  const gaps = [];
  const regular = sortedEpisodes(item.episodes.filter(value => value.number != null && episodeDay(value)));
  for (let index = 1; index < regular.length; index++) {
    const previous = regular[index - 1], next = regular[index];
    if (previous.season !== next.season) continue;
    const from = episodeDay(previous), to = episodeDay(next);
    const days = dayDifference(from, to);
    if (days > 8) gaps.push({ from, to, days, season: next.season });
  }
  return gaps;
}

export function calendarText(items, now = new Date()) {
  const escape = value => String(value ?? '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
  const stamp = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Personal Hub//TV Guide//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:My TV Guide'];
  const seen = new Set();
  for (const { item, episodes } of items) {
    for (const episode of sortedEpisodes(episodes)) {
      const day = episodeDay(episode);
      const uid = 'tvmaze-' + item.show.id + '-' + episode.id + '@personal-hub';
      if (!day || seen.has(uid)) continue;
      seen.add(uid);
      lines.push('BEGIN:VEVENT', 'UID:' + uid, 'DTSTAMP:' + stamp(now));
      if (timed(episode)) {
        lines.push('DTSTART:' + stamp(episode.airstamp));
        const minutes = episode.runtime || item.show.averageRuntime || item.show.runtime;
        if (minutes > 0) lines.push('DTEND:' + stamp(Date.parse(episode.airstamp) + minutes * 60000));
      } else {
        lines.push('DTSTART;VALUE=DATE:' + day.replaceAll('-', ''), 'DTEND;VALUE=DATE:' + addDays(day, 1).replaceAll('-', ''));
      }
      const platform = item.show.webChannel?.name || item.show.network?.name || 'Channel TBA';
      lines.push('SUMMARY:' + escape(item.show.name + ' · ' + episodeCode(episode) + ' · ' + (episode.name || 'Title TBA')));
      lines.push('DESCRIPTION:' + escape(platform + '\nSchedule from TVmaze. Dates may change. Downloaded calendars are snapshots.\n' + (episode.url || item.show.url)));
      lines.push('URL:' + (episode.url || item.show.url), 'STATUS:CONFIRMED', 'TRANSP:TRANSPARENT', 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  // Fold by UTF-8 bytes so titles with emoji or accents remain valid iCalendar.
  return lines.map(line => {
    let folded = '', part = '', length = 0;
    for (const character of line) {
      const bytes = new TextEncoder().encode(character).length;
      if (length + bytes > 75) { folded += part + '\r\n'; part = ' '; length = 1; }
      part += character;
      length += bytes;
    }
    return folded + part;
  }).join('\r\n') + '\r\n';
}
