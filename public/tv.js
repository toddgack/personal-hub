import { ZONE, DAY, localDay, addDays, weekStart, timed, episodeDay, episodeTime, episodeCode, seasonSummary, showState, releaseGaps, calendarText } from './tv-core.js';
import { SharedTVList } from './tv-shared.js?v=2';

const get = id => document.getElementById(id);
const prefix = 'personal-hub.tv.show.';
const library = new Map();
const pending = new Set();
const failures = new Set();
let tab = 'Active';
let displayedWeek = weekStart(localDay());
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

function formatDay(day, withYear = false) {
  if (!day) return 'Date TBA';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {})
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
    save({ ...item, archived: row.archived });
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
    const wasEmpty = library.size === 0;
    connected = true;
    if (firstConnection || shared.version !== previousVersion) applySharedList();
    if (wasEmpty && library.size && ![...library.values()].some(item => showState(item).group === tab)) {
      tab = [...library.values()].some(item => showState(item).group === 'Upcoming') ? 'Upcoming' : 'Past';
      render();
    }
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
    tab = showState(item).group;
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
      updated.archived = library.get(previous.show.id).archived;
      save(updated);
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
  get('updated').textContent = oldest ? 'Oldest schedule check · ' + new Intl.DateTimeFormat('en-US', { timeZone: ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(oldest)) : library.size ? 'Loading episode schedules…' : 'Add a show to your household list.';
}

function renderCard(item) {
  const state = showState(item);
  const card = node('article', 'show-card');
  const body = node('div', 'card-body');
  body.append(node('p', 'card-meta', channel(item.show)), button(item.show.name, 'detail', item.show.id, 'show-name'), node('span', 'tag' + (state.label === 'Awaiting dates' ? ' warm' : ''), item.checked ? state.label : 'Loading schedule'));
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

function render() {
  renderHero();
  const groups = { Active: [], Upcoming: [], Past: [] };
  [...library.values()].forEach(item => groups[showState(item).group].push(item));
  for (const group of Object.keys(groups)) {
    get(group.toLowerCase() + '-count').textContent = groups[group].length;
    document.querySelector('[data-tab="' + group + '"]').setAttribute('aria-pressed', String(group === tab));
  }
  get('collection-title').textContent = tab + ' shows';
  get('collection-note').textContent = {
    Active: 'Seasons releasing now, including breaks.',
    Upcoming: 'Future premieres and shows awaiting return dates.',
    Past: 'Ended series and shows you moved here.'
  }[tab];
  const filter = get('filter').value.trim().toLocaleLowerCase();
  const shows = groups[tab].filter(item => item.show.name.toLocaleLowerCase().includes(filter));
  shows.sort((a, b) => {
    const first = showState(a).next, second = showState(b).next;
    return (episodeDay(first || {}) || '9999').localeCompare(episodeDay(second || {}) || '9999') || a.show.name.localeCompare(b.show.name);
  });
  if (shows.length) get('shows').replaceChildren(...shows.map(renderCard));
  else {
    const empty = node('div', 'empty');
    empty.append(node('h3', '', !library.size ? 'Your shows belong here.' : filter ? 'No matching shows.' : 'No ' + tab.toLowerCase() + ' shows.'));
    empty.append(node('p', '', !library.size ? 'Search a title to see premieres, weekly releases and the breaks in between.' : filter ? 'Try another title in this collection.' : 'Shows move automatically as announced seasons start and finish.'));
    if (!filter) empty.append(button('Find a show', 'search', '', 'primary'));
    get('shows').replaceChildren(empty);
  }
  renderWeek();
}

function renderWeek() {
  const today = localDay();
  const end = addDays(displayedWeek, 6);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  get('week-label').textContent = formatter.formatRange(new Date(displayedWeek + 'T12:00:00Z'), new Date(end + 'T12:00:00Z'));
  get('schedule-heading').textContent = displayedWeek === weekStart(today) ? 'This week’s releases' : 'Weekly releases';
  get('this-week').disabled = displayedWeek === weekStart(today);
  const entries = [...library.values()].filter(item => !item.archived).flatMap(item =>
    item.episodes.map(episode => ({ item, episode }))
  );
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(displayedWeek, index);
    const panel = node('section', 'day' + (day === today ? ' today' : ''));
    const title = node('h3', '', new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(day + 'T12:00:00Z')));
    title.append(node('b', '', Number(day.slice(-2))));
    panel.append(title);
    const releases = entries.filter(entry => episodeDay(entry.episode) === day).sort((a, b) => (a.episode.airstamp || '').localeCompare(b.episode.airstamp || ''));
    if (!releases.length) panel.append(node('p', '', 'No releases listed'));
    for (const { item, episode } of releases) {
      const release = button('', 'detail', item.show.id, 'day-episode');
      release.append(node('strong', '', item.show.name), node('span', '', episodeCode(episode) + ' · ' + episodeTime(episode)));
      panel.append(release);
    }
    return panel;
  });
  get('week-days').replaceChildren(...days);
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

function openDetail(id) {
  if (!library.has(id)) return;
  detailId = id;
  renderDetail(true);
  get('show-dialog').showModal();
}

function renderDetail(resetSeason) {
  const item = library.get(detailId);
  get('show-title').textContent = item.show.name;
  get('show-meta').textContent = channel(item.show) + ' · ' + item.show.status + ' · ' + (item.show.schedule?.days?.join(', ') || 'Release days TBA');
  get('source-link').href = item.show.url;
  get('archive-show').textContent = item.archived ? 'Follow again' : 'Move to Past';
  const previous = Number(get('season').value);
  const numbers = [...new Set([...item.seasons.map(value => value.number), ...item.episodes.map(value => value.season)])].sort((a, b) => b - a);
  get('season').replaceChildren(...numbers.map(number => new Option('Season ' + number, number)));
  const next = showState(item).next;
  get('season').value = String(!resetSeason && numbers.includes(previous) ? previous : next?.season ?? numbers[0]);
  renderSeason();
}

function renderSeason() {
  const item = library.get(detailId);
  const number = Number(get('season').value);
  const summary = seasonSummary(item, number);
  const notes = [
    ['Season starts', summary.first ? formatDay(summary.first, true) : 'Not announced'],
    ['Season finale', summary.final ? formatDay(summary.final, true) : 'Not announced']
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
    const when = node('div', 'episode-date');
    const day = episodeDay(episode);
    when.append(node('div', '', formatDay(day)), node('p', '', episodeTime(episode)));
    if (day) when.append(button('Calendar', 'episode-calendar', episode.id));
    row.append(info, when);
    return row;
  }));
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
  if (action.dataset.action === 'episode-calendar') {
    const item = library.get(detailId);
    download([{ item, episodes: item.episodes.filter(episode => episode.id === id) }], 'tv-episode-' + id);
  }
});
get('open-search').addEventListener('click', () => get('search-dialog').showModal());
get('search-form').addEventListener('submit', event => { event.preventDefault(); search(); });
get('example').addEventListener('click', () => { get('query').value = 'Only Murders in the Building'; search(); });
get('filter').addEventListener('input', render);
get('refresh').addEventListener('click', () => refreshSchedules(true));
get('download').addEventListener('click', upcomingCalendar);
get('next-show').addEventListener('click', () => openDetail(Number(get('next-show').dataset.id)));
get('season').addEventListener('change', renderSeason);
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
    tab = showState(library.get(id)).group;
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
get('previous-week').addEventListener('click', () => { displayedWeek = addDays(displayedWeek, -7); renderWeek(); });
get('next-week').addEventListener('click', () => { displayedWeek = addDays(displayedWeek, 7); renderWeek(); });
get('this-week').addEventListener('click', () => { displayedWeek = weekStart(localDay()); renderWeek(); });
window.addEventListener('storage', event => {
  if (!event.key || event.key.startsWith(prefix)) syncList();
});
loadLibrary();
if (library.size && ![...library.values()].some(item => showState(item).group === 'Active')) {
  tab = [...library.values()].some(item => showState(item).group === 'Upcoming') ? 'Upcoming' : 'Past';
}
render();
syncList();
let lastToday = localDay();
setInterval(() => {
  const today = localDay();
  if (today !== lastToday) {
    if (displayedWeek === weekStart(lastToday)) displayedWeek = weekStart(today);
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
