import { ZONE, DAY, localDay, addDays, dayDifference, weekStart, timed, released, episodeDay, episodeTime, episodeCode, seasonSummary, seasonProgress, queuedSeasons, defaultSeason, showState, releaseGaps, calendarText } from './tv-core.js?v=watch-1';
import { SharedTVList } from './tv-shared.js?v=watch-1';

const get = id => document.getElementById(id);
const prefix = 'personal-hub.tv.show.';
const library = new Map();
const pending = new Set();
const failures = new Set();
let tab = 'Queue';
let displayedWeek = weekStart(localDay());
let scheduleView = 'week';
let rangeEnd = addDays(displayedWeek, 6);
let detailId = null;
let searchResults = [];
let searchVersion = 0;
let refreshing = false;
let queue = Promise.resolve();
let lastRequest = 0;
let storageAvailable = true;
const shared = new SharedTVList();
let sharedTask = null;
let connected = false;
let syncFailed = false;

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function button(text, action, id, className = '') {
  const element = node('button', className, text);
  element.type = 'button';
  element.dataset.action = action;
  element.dataset.id = id;
  return element;
}

function formatDay(day) {
  if (!day) return 'Date TBA';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  }).format(new Date(day + 'T12:00:00Z'));
}

function channel(show) {
  return show.webChannel?.name || show.network?.name || 'Channel TBA';
}

function announce(message) {
  get('status').textContent = message;
}

function loadLibrary() {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key.startsWith(prefix)) continue;
      try {
        const item = JSON.parse(localStorage.getItem(key));
        if (Number.isInteger(item?.show?.id) && key === prefix + item.show.id && Array.isArray(item.episodes) && Array.isArray(item.seasons)) library.set(item.show.id, item);
      } catch {
        announce('A saved show could not be read. Your other shows are available.');
      }
    }
  } catch {
    storageAvailable = false;
    announce('This browser cannot cache schedules. The shared list can still load while you are online.');
  }
}

function save(item) {
  library.set(item.show.id, item);
  try {
    localStorage.setItem(prefix + item.show.id, JSON.stringify(item));
  } catch {
    storageAvailable = false;
    announce('This browser could not cache schedules. Your shared list is saved in Cloudflare.');
  }
}

function applySharedList() {
  const members = shared.members();
  const ids = new Set(members.map(row => row.id));
  for (const id of library.keys()) {
    if (ids.has(id)) continue;
    library.delete(id);
    failures.delete(id);
    try { localStorage.removeItem(prefix + id); } catch {}
  }
  for (const row of members) {
    const item = library.get(row.id) || {
      show: { id: row.id, name: row.name, status: 'Unknown' },
      episodes: [], seasons: [], checked: 0
    };
    save({ ...item, archived: row.archived,
      watchSeasons: shared.watchSeasons.filter(value => value.showId === row.id),
      watched: shared.watched.filter(value => value.showId === row.id)
    });
  }
  if (detailId != null && !library.has(detailId)) {
    get('show-dialog').close();
    detailId = null;
  }
  render();
  if (detailId != null && get('show-dialog').open) renderDetail(false);
}

function syncList() {
  if (sharedTask) return sharedTask;
  sharedTask = loadSharedList().finally(() => { sharedTask = null; });
  return sharedTask;
}

async function loadSharedList() {
  if (!connected) get('sync-state').textContent = 'Loading your shared shows…';
  try {
    const previousVersion = shared.version;
    const firstConnection = !connected;
    if (connected) await shared.pull();
    else await shared.connect([...library.values()]);
    connected = true;
    if (firstConnection || shared.version !== previousVersion) applySharedList();
    get('sync-state').textContent = 'Shared household list';
    if (syncFailed) announce('Your shared shows are loaded.');
    syncFailed = false;
    // Episode details are a local cache. The saved show membership comes from Cloudflare.
    refreshSchedules();
  } catch {
    syncFailed = true;
    get('sync-state').textContent = 'Shared shows unavailable · retrying automatically';
  }
}

function request(path) {
  const task = queue.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const delay = Math.max(0, 550 - (Date.now() - lastRequest));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      lastRequest = Date.now();
      const response = await fetch('https://api.tvmaze.com' + path, { signal: AbortSignal.timeout(20000) });
      if (response.status === 429 && attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }
      if (!response.ok) throw new Error(response.status === 429 ? 'The schedule service is busy. Try again shortly.' : 'Schedules are unavailable right now. Try again.');
      return response.json();
    }
  });
  queue = task.catch(() => {});
  return task;
}

function compactShow(show) {
  const { id, name, status, premiered, ended, schedule, network, webChannel, image, url, averageRuntime, runtime } = show;
  return { id, name, status, premiered, ended, schedule, network, webChannel, image, url, averageRuntime, runtime };
}

async function fetchShow(id) {
  const show = await request('/shows/' + id);
  const episodes = await request('/shows/' + id + '/episodes?specials=1');
  const seasons = await request('/shows/' + id + '/seasons');
  if (!Array.isArray(episodes) || !Array.isArray(seasons)) throw new Error('The schedule could not be read. Try refreshing.');
  return {
    show: compactShow(show),
    episodes: episodes.map(({ id, name, season, number, airdate, airtime, airstamp, runtime, url }) => ({ id, name, season, number, airdate, airtime, airstamp, runtime, url })),
    seasons: seasons.map(({ id, number, premiereDate, endDate, episodeOrder }) => ({ id, number, premiereDate, endDate, episodeOrder })),
    checked: Date.now(), archived: false
  };
}

async function search() {
  const query = get('query').value.trim();
  if (query.length < 2) return;
  const version = ++searchVersion;
  get('example').hidden = true;
  get('search-results').replaceChildren();
  get('search-status').textContent = 'Looking for shows…';
  try {
    const results = await request('/search/shows?q=' + encodeURIComponent(query));
    if (version !== searchVersion) return;
    searchResults = results.map(result => result.show);
    get('search-status').textContent = searchResults.length ? 'Choose the right title to add it to your guide.' : 'No matches. Try a shorter title or check the spelling.';
    renderSearch();
  } catch (error) {
    if (version === searchVersion) get('search-status').textContent = error.message || 'Search could not connect. Try again.';
  }
}

function poster(show, className = 'poster') {
  if (!show.image?.medium) return node('div', className + ' poster-placeholder', 'TV');
  const image = node('img', className);
  image.src = show.image.medium;
  image.alt = '';
  image.loading = 'lazy';
  image.addEventListener('error', () => image.replaceWith(node('div', className + ' poster-placeholder', 'TV')), { once: true });
  return image;
}

function renderSearch() {
  get('search-results').replaceChildren(...searchResults.map(show => {
    const result = node('article', 'result');
    const info = node('div');
    info.append(node('h3', '', show.name), node('p', '', [show.premiered?.slice(0, 4), channel(show), show.status].filter(Boolean).join(' · ')));
    const saved = library.has(show.id);
    const add = button(saved ? 'Added' : pending.has(show.id) ? 'Adding…' : 'Add', 'add', show.id);
    add.disabled = saved || pending.has(show.id);
    add.setAttribute('aria-label', (saved ? 'Added ' : 'Add ') + show.name);
    result.append(poster(show), info, add);
    return result;
  }));
}

async function addShow(id) {
  if (pending.has(id) || library.has(id)) return;
  pending.add(id);
  renderSearch();
  get('search-status').textContent = 'Getting episodes and season dates…';
  try {
    if (!connected) await syncList();
    if (!connected) throw new Error('Your shared shows could not connect. The page is retrying automatically. Please try adding the show again in a moment.');
    const item = await fetchShow(id);
    await shared.change(item);
    save(item);
    applySharedList();
    tab = 'Queue';
    render();
    get('search-status').textContent = item.show.name + ' added to the household guide.';
  } catch (error) {
    if (shared.ready && connected) applySharedList();
    get('search-status').textContent = error.message || 'Could not add this show. Try again.';
  } finally {
    pending.delete(id);
    renderSearch();
  }
}

async function refreshSchedules(force = false) {
  if (refreshing) return;
  const due = [...library.values()].filter(item => force || Date.now() - (item.checked || 0) >= DAY);
  if (!due.length) return;
  refreshing = true;
  get('refresh').disabled = true;
  get('refresh').textContent = 'Refreshing…';
  let failed = 0;
  for (const previous of due) {
    if (!library.has(previous.show.id)) continue;
    try {
      const updated = await fetchShow(previous.show.id);
      if (!library.has(previous.show.id) || (connected && !shared.members().some(row => row.id === previous.show.id))) continue;
      const cached = library.get(previous.show.id);
      save({ ...updated, archived: cached.archived, watchSeasons: cached.watchSeasons, watched: cached.watched });
      failures.delete(previous.show.id);
    } catch {
      failed++;
      failures.add(previous.show.id);
    }
  }
  refreshing = false;
  get('refresh').textContent = 'Refresh schedules';
  render();
  if (detailId != null && library.has(detailId) && get('show-dialog').open) renderDetail(false);
  if (storageAvailable) announce(failed ? 'Could not refresh ' + failed + (failed === 1 ? ' show. ' : ' shows. ') + 'Saved dates are still shown. Use Refresh schedules to retry.' : 'Schedules are up to date.');
}

function nextEntries() {
  const today = localDay();
  return [...library.values()].filter(item => !item.archived).flatMap(item =>
    item.episodes.filter(episode => episodeDay(episode) >= today && (!timed(episode) || Date.parse(episode.airstamp) >= Date.now())).map(episode => ({ item, episode }))
  ).sort((a, b) => episodeDay(a.episode).localeCompare(episodeDay(b.episode)) || (a.episode.airstamp || '').localeCompare(b.episode.airstamp || ''));
}

function renderHero() {
  const next = nextEntries()[0];
  get('next-show').hidden = !next;
  get('download').disabled = !next;
  get('refresh').disabled = refreshing || !library.size;
  if (next) {
    get('next-title').textContent = next.item.show.name;
    get('next-detail').textContent = episodeCode(next.episode) + ' · ' + formatDay(episodeDay(next.episode)) + ' · ' + episodeTime(next.episode) + ' · ' + channel(next.item.show);
    get('next-show').dataset.id = next.item.show.id;
  } else {
    get('next-title').textContent = library.size ? 'Waiting for the next announcement.' : 'Something to look forward to.';
    get('next-detail').textContent = library.size ? 'Your saved shows stay here while new episode dates are announced.' : 'Find your shows and keep their release dates together.';
  }
  const checks = [...library.values()].map(item => item.checked || 0);
  const oldest = checks.length ? Math.min(...checks) : 0;
  get('updated').textContent = oldest ? 'Oldest schedule check · ' + new Intl.DateTimeFormat('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(oldest)) : library.size ? 'Loading episode schedules…' : 'Add a show to your household list.';
}

function renderCard(item) {
  const state = showState(item);
  const card = node('article', 'show-card');
  const body = node('div', 'card-body');
  body.append(node('p', 'card-meta', channel(item.show)), button(item.show.name, 'detail', item.show.id, 'show-name'), node('span', 'tag' + (state.label === 'Awaiting dates' ? ' warm' : ''), item.checked ? item.archived ? 'Release tracking paused' : state.label : 'Loading schedule'));
  if (state.next) {
    body.append(node('p', 'card-next', episodeCode(state.next) + ' · ' + formatDay(episodeDay(state.next))));
  } else {
    const premiere = item.seasons.filter(value => value.premiereDate > localDay()).sort((a, b) => a.premiereDate.localeCompare(b.premiereDate))[0];
    body.append(node('p', 'card-next', premiere ? 'Season ' + premiere.number + ' starts ' + formatDay(premiere.premiereDate) : state.group === 'Past' ? 'Past releases available in the episode schedule.' : 'Next release date has not been announced.'));
  }
  const gap = releaseGaps(item).find(value => value.from <= localDay() && value.to > localDay());
  if (gap && !item.archived) body.append(node('p', 'card-gap', gap.days + '-day gap · returns ' + formatDay(gap.to)));
  if (failures.has(item.show.id)) body.append(node('p', 'card-gap', 'Refresh failed · showing saved dates'));
  body.append(button('Episode schedule', 'detail', item.show.id, 'card-link'));
  card.append(poster(item.show), body);
  return card;
}

function seasonButton(text, action, entry, episodeId) {
  const control = button(text, action, episodeId ?? entry.item.show.id);
  control.dataset.showId = entry.item.show.id;
  control.dataset.season = entry.number;
  control.disabled = pending.has(entry.item.show.id);
  return control;
}

function renderWatchCard(entry, log = false) {
  const { item, number, progress } = entry;
  const card = node('article', 'show-card');
  const body = node('div', 'card-body');
  const title = seasonButton(item.show.name, 'season-detail', entry);
  title.className = 'show-name';
  body.append(node('p', 'card-meta', 'Season ' + number + ' · ' + channel(item.show)), title,
    node('span', 'tag' + (progress.mode === 'binge' && !progress.finished ? ' warm' : ''), progress.label));
  body.append(node('p', 'card-meta', (progress.mode === 'binge' ? 'Save to binge' : 'Watch as released') + ' · ' + progress.count + ' / ' + (progress.total || '?') + ' watched'));
  const meter = node('progress', 'watch-meter');
  meter.max = progress.total || 1;
  meter.value = progress.count;
  meter.setAttribute('aria-label', 'Season ' + number + ' watch progress');
  body.append(meter);
  if (log && progress.lastWatched) {
    body.append(node('p', 'card-next', 'Last watched · ' + formatDay(localDay(progress.lastWatched))));
  } else if (progress.mode === 'binge' && !progress.finished) {
    body.append(node('p', 'card-next', progress.final ? 'Full season expected · ' + formatDay(progress.final) : 'Finale date has not been announced.'));
  } else if (progress.remaining[0]) {
    const next = progress.remaining[0];
    body.append(node('p', 'card-next', 'Next to watch · ' + episodeCode(next) + ' · ' + (next.name || 'Title TBA')));
  } else {
    const future = progress.episodes.find(episode => !released(episode) && episodeDay(episode));
    body.append(node('p', 'card-next', future ? 'Next release · ' + formatDay(episodeDay(future)) : 'Waiting for the next announced episode.'));
  }
  const actions = node('div', 'watch-actions');
  actions.append(seasonButton('Season & episodes', 'season-detail', entry));
  if (!log && progress.remaining[0] && (progress.mode === 'release' || progress.finished)) {
    actions.append(seasonButton('Mark next watched', 'watch-next', entry, progress.remaining[0].id));
  }
  body.append(actions);
  card.append(poster(item.show), body);
  return card;
}

function render() {
  renderHero();
  const all = [...library.values()];
  const queueEntries = all.flatMap(item => queuedSeasons(item));
  const logEntries = all.flatMap(item => [...new Set((item.watched || []).map(row => row.season))].map(number => ({ item, number, progress: seasonProgress(item, number) })));
  logEntries.sort((a, b) => b.progress.lastWatched.localeCompare(a.progress.lastWatched));
  const counts = { Queue: queueEntries.length, Watched: logEntries.length, Shows: all.length };
  for (const group of Object.keys(counts)) {
    get(group.toLowerCase() + '-count').textContent = counts[group];
    document.querySelector('[data-tab="' + group + '"]').setAttribute('aria-pressed', String(group === tab));
  }
  get('collection-title').textContent = { Queue: 'Your queue', Watched: 'Watched log', Shows: 'All your shows' }[tab];
  get('collection-note').textContent = {
    Queue: 'Seasons stay here until you finish watching or remove them.',
    Watched: 'Episodes and seasons you’ve marked watched, most recent first.',
    Shows: 'Browse every saved show and add any season to your queue.'
  }[tab];
  get('release-filter-label').hidden = tab !== 'Shows';
  const filter = get('filter').value.trim().toLocaleLowerCase();
  const matches = item => item.show.name.toLocaleLowerCase().includes(filter);
  const shows = all.filter(item => matches(item) && (get('release-filter').value === 'All' || get('release-filter').value === '' || showState(item).group === get('release-filter').value));
  shows.sort((a, b) => {
    const first = showState(a).next, second = showState(b).next;
    return (episodeDay(first || {}) || '9999').localeCompare(episodeDay(second || {}) || '9999') || a.show.name.localeCompare(b.show.name);
  });
  const cards = tab === 'Shows' ? shows.map(renderCard) : (tab === 'Queue' ? queueEntries : logEntries).filter(entry => matches(entry.item)).map(entry => renderWatchCard(entry, tab === 'Watched'));
  if (cards.length) get('shows').replaceChildren(...cards);
  else {
    const empty = node('div', 'empty');
    let heading = {
      Queue: all.some(item => !item.checked) ? 'Loading your queue…' : 'Your queue is clear.',
      Watched: 'Your watched log starts here.',
      Shows: 'No shows in this view.'
    }[tab];
    let message = tab === 'Watched' ? 'Mark an episode or a season watched to save your progress.' : 'Open a saved show and choose the season you want to watch.';
    if (!library.size) {
      heading = 'Your shows belong here.';
      message = 'Search a title to start your queue and follow its releases.';
    } else if (filter) {
      heading = 'No matching shows.';
      message = 'Try another title in this collection.';
    }
    empty.append(node('h3', '', heading), node('p', '', message));
    if (!filter) empty.append(button('Find a show', 'search', '', 'primary'));
    get('shows').replaceChildren(empty);
  }
  renderWeek();
}

function scheduleEnd() {
  if (scheduleView === 'range') return rangeEnd;
  if (scheduleView === 'week') return addDays(displayedWeek, 6);
  const date = new Date(displayedWeek + 'T12:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + 1);
  return addDays(date.toISOString().slice(0, 10), -1);
}

function updateScheduleControls() {
  const month = scheduleView === 'month';
  const range = scheduleView === 'range';
  get('schedule-view').value = scheduleView;
  get('jump-date-field').hidden = month;
  get('jump-date').disabled = month;
  get('jump-month-field').hidden = !month;
  get('jump-month').disabled = !month;
  get('jump-end-field').hidden = !range;
  get('jump-end').disabled = !range;
  get('jump-date-label').textContent = range ? 'From' : 'Go to date';
  get('jump-date').value = displayedWeek;
  get('jump-month').value = displayedWeek.slice(0, 7);
  get('jump-end').value = rangeEnd;
  get('schedule-error').textContent = '';
}

function changePeriod(direction) {
  if (scheduleView === 'month') {
    const date = new Date(displayedWeek + 'T12:00:00Z');
    date.setUTCMonth(date.getUTCMonth() + direction);
    displayedWeek = date.toISOString().slice(0, 10);
  } else {
    const days = scheduleView === 'week' ? 7 : dayDifference(displayedWeek, rangeEnd) + 1;
    displayedWeek = addDays(displayedWeek, direction * days);
    if (scheduleView === 'range') rangeEnd = addDays(rangeEnd, direction * days);
  }
  updateScheduleControls();
  renderWeek();
}

function renderWeek() {
  const today = localDay();
  const end = scheduleEnd();
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  get('week-label').textContent = formatter.formatRange(new Date(displayedWeek + 'T12:00:00Z'), new Date(end + 'T12:00:00Z'));
  get('schedule-heading').textContent = scheduleView === 'month' ? 'Monthly releases' : scheduleView === 'range' ? 'Releases in your date range' : displayedWeek === weekStart(today) ? 'This week’s releases' : 'Weekly releases';
  const currentStart = scheduleView === 'week' ? weekStart(today) : scheduleView === 'month' ? today.slice(0, 7) + '-01' : today;
  get('this-week').disabled = displayedWeek === currentStart;
  get('this-week').textContent = scheduleView === 'week' ? 'This week' : scheduleView === 'month' ? 'This month' : 'Today';
  get('previous-week').setAttribute('aria-label', 'Previous ' + scheduleView);
  get('next-week').setAttribute('aria-label', 'Next ' + scheduleView);
  const entries = [...library.values()].filter(item => !item.archived).flatMap(item =>
    item.episodes.map(episode => ({ item, episode }))
  );
  const releaseDates = [...new Set(entries.map(entry => episodeDay(entry.episode)))].filter(day => day && day >= displayedWeek && day <= end).sort();
  const days = releaseDates.map(day => {
    const releases = entries.filter(entry => episodeDay(entry.episode) === day).sort((a, b) => (a.episode.airstamp || '').localeCompare(b.episode.airstamp || ''));
    const panel = node('section', 'day' + (day === today ? ' today' : ''));
    const title = node('h3');
    const date = node('time', '', formatDay(day));
    date.dateTime = day;
    title.append(date);
    panel.append(title);
    const list = node('div', 'day-releases');
    for (const { item, episode } of releases) {
      const release = button('', 'detail', item.show.id, 'day-episode');
      release.append(node('strong', '', item.show.name), node('span', '', episodeCode(episode) + ' · ' + episodeTime(episode)));
      list.append(release);
    }
    panel.append(list);
    return panel;
  });
  const emptyMessage = scheduleView === 'week' ? 'No releases scheduled this week.' : scheduleView === 'month' ? 'No releases scheduled this month.' : 'No releases scheduled in this date range.';
  get('week-days').replaceChildren(...(days.length ? days : [node('p', 'week-empty muted', emptyMessage)]));
  const notices = [];
  for (const item of library.values()) {
    if (item.archived) continue;
    for (const gap of releaseGaps(item)) {
      if (gap.from < end && gap.to > displayedWeek) {
        notices.push(node('p', 'week-notice', item.show.name + ' · ' + gap.days + ' days between listed episodes, ' + formatDay(gap.from) + ' to ' + formatDay(gap.to) + '. The source has no episodes listed between these dates.'));
      }
    }
  }
  get('week-notes').replaceChildren(...notices);
}

function openDetail(id, season) {
  if (!library.has(id)) return;
  detailId = id;
  renderDetail(true);
  if (season !== undefined) {
    get('season').value = String(season);
    renderSeason();
  }
  get('show-dialog').showModal();
}

function renderDetail(resetSeason) {
  const item = library.get(detailId);
  get('show-title').textContent = item.show.name;
  get('show-meta').textContent = channel(item.show) + ' · ' + item.show.status + ' · ' + (item.show.schedule?.days?.join(', ') || 'Release days TBA');
  get('source-link').href = item.show.url;
  get('archive-show').textContent = item.archived ? 'Resume release tracking' : 'Pause release tracking';
  const previous = Number(get('season').value);
  const numbers = [...new Set([...item.seasons.map(value => value.number), ...item.episodes.map(value => value.season)])].sort((a, b) => b - a);
  get('season').replaceChildren(...numbers.map(number => new Option('Season ' + number, number)));
  get('season').value = String(!resetSeason && numbers.includes(previous) ? previous : defaultSeason(item) ?? numbers[0]);
  renderSeason();
}

function renderSeason() {
  const item = library.get(detailId);
  const number = Number(get('season').value);
  const summary = seasonSummary(item, number);
  const progress = seasonProgress(item, number);
  get('watch-mode').value = progress.mode;
  get('watch-mode').disabled = pending.has(detailId) || !Number.isInteger(number) || !get('season').value;
  get('queue-season').textContent = progress.complete ? 'Season watched' : progress.queued ? 'Remove season from queue' : 'Add season to queue';
  get('queue-season').disabled = pending.has(detailId) || progress.complete || !get('season').value;
  get('watch-season').textContent = progress.complete ? 'Mark season unwatched' : progress.finished ? 'Mark season watched' : 'Mark released episodes watched';
  get('watch-season').disabled = pending.has(detailId) || (!progress.complete && !progress.remaining.length);
  get('watch-progress').textContent = progress.label + ' · ' + progress.count + ' / ' + (progress.total || '?') + ' episodes watched';
  const notes = [
    ['Season starts', summary.first ? formatDay(summary.first) : 'Not announced'],
    ['Season finale', summary.final ? formatDay(summary.final) : 'Not announced']
  ];
  get('season-summary').replaceChildren(...notes.map(([label, text]) => {
    const part = node('p');
    part.append(node('strong', '', label), document.createTextNode(text));
    return part;
  }));
  const gaps = releaseGaps(item).filter(value => value.season === number);
  get('gaps').replaceChildren(...gaps.map(gap => node('p', 'week-notice', gap.days + ' days between releases · ' + formatDay(gap.from) + ' to ' + formatDay(gap.to))));
  get('season-download').disabled = !summary.episodes.some(episodeDay);
  if (!summary.episodes.length) {
    get('episodes').replaceChildren(node('li', 'muted', 'Episode dates have not been announced yet.'));
    return;
  }
  get('episodes').replaceChildren(...summary.episodes.map(episode => {
    const row = node('li');
    const info = node('div');
    const title = episode.name && episode.name !== 'TBA' ? episode.name : 'Title TBA';
    info.append(node('p', '', episodeCode(episode)), node('h3', '', title));
    const watched = progress.watchedIds.has(episode.id);
    const watch = button(watched ? 'Watched · Undo' : released(episode) ? 'Mark watched' : 'Not released', 'episode-watch', episode.id, 'watch-toggle');
    watch.setAttribute('aria-pressed', String(watched));
    watch.setAttribute('aria-label', (watched ? 'Mark unwatched ' : 'Mark watched ') + episodeCode(episode));
    watch.disabled = pending.has(detailId) || (!watched && !released(episode));
    info.append(watch);
    if (watched) {
      row.className = 'watched-episode';
      const record = (item.watched || []).find(value => value.episodeId === episode.id);
      info.append(node('p', 'card-meta', 'Watched · ' + formatDay(localDay(record.watchedAt))));
    }
    const when = node('div', 'episode-date');
    const day = episodeDay(episode);
    when.append(node('div', '', formatDay(day)), node('p', '', episodeTime(episode)));
    if (day) when.append(button('Calendar', 'episode-calendar', episode.id));
    row.append(info, when);
    return row;
  }));
}

async function saveWatchChange(id, action) {
  if (pending.has(id)) return;
  pending.add(id);
  render();
  if (detailId === id && get('show-dialog').open) renderDetail(false);
  try {
    if (!connected) await syncList();
    await action();
    applySharedList();
    announce('Watch progress saved for your household.');
  } catch (error) {
    if (connected) applySharedList();
    announce(error.message || 'Watch progress could not save. Try again.');
  } finally {
    pending.delete(id);
    render();
    if (detailId === id && get('show-dialog').open) renderDetail(false);
  }
}

function download(items, name) {
  const count = items.reduce((sum, entry) => sum + entry.episodes.filter(episodeDay).length, 0);
  if (!count) { announce('No announced dates are available to download.'); return; }
  const text = calendarText(items);
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const link = node('a');
  link.href = url;
  link.download = name + '.ics';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  announce('Calendar downloaded with ' + count + (count === 1 ? ' episode. ' : ' episodes. ') + 'Import the .ics file into your calendar. Download again after schedule changes.');
}

function upcomingCalendar() {
  const today = localDay();
  download([...library.values()].filter(item => !item.archived).map(item => ({
    item, episodes: item.episodes.filter(episode => episodeDay(episode) >= today)
  })), 'my-tv-guide');
}

document.addEventListener('click', event => {
  const close = event.target.closest('[data-close]');
  if (close) { get(close.dataset.close).close(); return; }
  const collection = event.target.closest('[data-tab]');
  if (collection) { tab = collection.dataset.tab; render(); return; }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  const id = Number(action.dataset.id);
  if (action.dataset.action === 'search') get('search-dialog').showModal();
  if (action.dataset.action === 'add') addShow(id);
  if (action.dataset.action === 'detail') openDetail(id);
  if (action.dataset.action === 'season-detail') openDetail(id, Number(action.dataset.season));
  if (action.dataset.action === 'watch-next') {
    const showId = Number(action.dataset.showId);
    saveWatchChange(showId, () => shared.watch(showId, Number(action.dataset.season), [id], true));
  }
  if (action.dataset.action === 'episode-watch') {
    const item = library.get(detailId);
    const episode = item.episodes.find(value => value.id === id);
    if (!episode) return;
    const watched = (item.watched || []).some(value => value.episodeId === id);
    if (!watched && !released(episode)) return;
    saveWatchChange(item.show.id, () => shared.watch(item.show.id, episode.season, [id], !watched));
  }
  if (action.dataset.action === 'episode-calendar') {
    const item = library.get(detailId);
    download([{ item, episodes: item.episodes.filter(episode => episode.id === id) }], 'tv-episode-' + id);
  }
});
get('open-search').addEventListener('click', () => get('search-dialog').showModal());
get('search-form').addEventListener('submit', event => { event.preventDefault(); search(); });
get('example').addEventListener('click', () => { get('query').value = 'Only Murders in the Building'; search(); });
get('filter').addEventListener('input', render);
get('release-filter').addEventListener('change', render);
get('refresh').addEventListener('click', () => refreshSchedules(true));
get('download').addEventListener('click', upcomingCalendar);
get('next-show').addEventListener('click', () => openDetail(Number(get('next-show').dataset.id)));
get('season').addEventListener('change', renderSeason);
get('watch-mode').addEventListener('change', () => {
  const id = detailId, season = Number(get('season').value), mode = get('watch-mode').value;
  saveWatchChange(id, () => shared.season(id, season, true, mode));
});
get('queue-season').addEventListener('click', () => {
  const item = library.get(detailId), season = Number(get('season').value);
  const progress = seasonProgress(item, season);
  saveWatchChange(item.show.id, () => shared.season(item.show.id, season, !progress.queued, progress.mode));
});
get('watch-season').addEventListener('click', () => {
  const item = library.get(detailId), season = Number(get('season').value);
  const progress = seasonProgress(item, season);
  const episodes = (progress.complete ? progress.available : progress.remaining).map(episode => episode.id);
  if (episodes.length) saveWatchChange(item.show.id, () => shared.watch(item.show.id, season, episodes, !progress.complete));
});
get('season-download').addEventListener('click', () => {
  const item = library.get(detailId);
  const number = Number(get('season').value);
  download([{ item, episodes: item.episodes.filter(episode => episode.season === number) }], 'tv-' + detailId + '-season-' + number);
});
get('archive-show').addEventListener('click', async () => {
  if (pending.has(detailId)) return;
  const item = library.get(detailId);
  const id = item.show.id;
  pending.add(id);
  get('archive-show').disabled = true;
  try {
    await shared.change({ ...item, archived: !item.archived });
    applySharedList();
    tab = 'Shows';
    render();
    announce(item.show.name + ' updated for both devices.');
  } catch (error) {
    if (connected) applySharedList();
    announce(error.message || 'The change could not sync. Try again.');
  } finally {
    pending.delete(id);
    get('archive-show').disabled = false;
  }
});
get('remove-show').addEventListener('click', async () => {
  if (pending.has(detailId)) return;
  const item = library.get(detailId);
  const id = item.show.id;
  pending.add(id);
  get('remove-show').disabled = true;
  try {
    await shared.change(item, true);
    applySharedList();
    announce(item.show.name + ' removed from the household guide. You can add it again through search.');
  } catch (error) {
    if (connected) applySharedList();
    announce(error.message || 'The removal could not sync. Try again.');
  } finally {
    pending.delete(id);
    get('remove-show').disabled = false;
  }
});
get('previous-week').addEventListener('click', () => changePeriod(-1));
get('next-week').addEventListener('click', () => changePeriod(1));
get('this-week').addEventListener('click', () => {
  const today = localDay();
  const days = dayDifference(displayedWeek, rangeEnd);
  displayedWeek = scheduleView === 'week' ? weekStart(today) : scheduleView === 'month' ? today.slice(0, 7) + '-01' : today;
  if (scheduleView === 'range') rangeEnd = addDays(displayedWeek, days);
  updateScheduleControls();
  renderWeek();
});
get('schedule-view').addEventListener('change', () => {
  const end = scheduleEnd();
  scheduleView = get('schedule-view').value;
  if (scheduleView === 'month') displayedWeek = displayedWeek.slice(0, 7) + '-01';
  if (scheduleView === 'week') displayedWeek = weekStart(displayedWeek);
  if (scheduleView === 'range') rangeEnd = end;
  updateScheduleControls();
  renderWeek();
});
get('schedule-form').addEventListener('submit', event => {
  event.preventDefault();
  const start = scheduleView === 'month' ? get('jump-month').value + '-01' : get('jump-date').value;
  const end = get('jump-end').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start + 'T12:00:00Z'))) {
    get('schedule-error').textContent = 'Choose a valid date or month.';
    return;
  }
  if (scheduleView === 'range' && (!/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isFinite(Date.parse(end + 'T12:00:00Z')) || end < start)) {
    get('schedule-error').textContent = 'Choose an end date on or after the start date.';
    return;
  }
  displayedWeek = scheduleView === 'week' ? weekStart(start) : start;
  if (scheduleView === 'range') rangeEnd = end;
  updateScheduleControls();
  renderWeek();
});
window.addEventListener('storage', event => {
  if (!event.key || event.key.startsWith(prefix)) syncList();
});
loadLibrary();
updateScheduleControls();
render();
syncList();
let lastToday = localDay();
setInterval(() => {
  const today = localDay();
  if (today !== lastToday) {
    if (scheduleView === 'week' && displayedWeek === weekStart(lastToday)) {
      displayedWeek = weekStart(today);
      updateScheduleControls();
    }
    lastToday = today;
    render();
  }
  if (document.visibilityState === 'visible') refreshSchedules();
}, 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { render(); syncList(); }
});
window.addEventListener('online', () => syncList());
setInterval(() => {
  if (document.visibilityState === 'visible') syncList();
}, 15000);
