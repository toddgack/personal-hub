import { FORECAST, AAP_DAILY_ML, arizonaDay, currentWeek, weekStart, addDays, forecastRow, totals, referenceBand, bandPosition } from './formula-core.js';

const get = id => document.getElementById(id);
const write = (id, text) => { get(id).textContent = text; };
const number = value => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value);
const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const date = day => dayFormat.format(new Date(day + 'T12:00:00Z'));
const signed = value => (value > 0 ? '+' : value < 0 ? '−' : '') + number(Math.abs(value));
const requestedWeek = Number(new URLSearchParams(location.search).get('week'));
let selectedWeek = requestedWeek >= 1 && requestedWeek <= 52 && Number.isInteger(requestedWeek) ? requestedWeek : Math.min(52, currentWeek());
let baseBottle, baseFeeds, trialBottle, trialFeeds;
let chartWindow = { start: 1, end: 52, left: 42, right: 15, width: 500 };

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function loadWeek(week) {
  selectedWeek = Number(week);
  const row = forecastRow(selectedWeek);
  baseBottle = row.bottle;
  baseFeeds = row.feeds;
  trialBottle = baseBottle + 10;
  trialFeeds = baseFeeds;
  fillControls();
  render();
}

function fillControls() {
  get('week').value = String(selectedWeek);
  get('week-slider').value = String(selectedWeek);
  get('base-bottle').value = String(baseBottle);
  get('base-feeds').value = String(baseFeeds);
  get('trial-bottle').value = String(trialBottle);
  get('trial-feeds').value = String(trialFeeds);
}

function readControls(event) {
  const bottle = get('base-bottle').valueAsNumber;
  const feeds = get('base-feeds').valueAsNumber;
  const trial = get('trial-bottle').valueAsNumber;
  const trialCount = get('trial-feeds').valueAsNumber;
  if (![bottle, trial].every(value => Number.isInteger(value) && value >= 1 && value <= 500) ||
      ![feeds, trialCount].every(value => Number.isInteger(value) && value >= 1 && value <= 24)) {
    write('input-error', 'Enter 1–500 mL per bottle and 1–24 feeds per day. Results show the last valid comparison.');
    return;
  }
  if (event.target.id === 'base-bottle') trialBottle = Math.max(1, Math.min(500, bottle + trialBottle - baseBottle));
  else trialBottle = trial;
  if (event.target.id === 'base-feeds') trialFeeds = Math.max(1, Math.min(24, feeds + trialFeeds - baseFeeds));
  else trialFeeds = trialCount;
  baseBottle = bottle;
  baseFeeds = feeds;
  fillControls();
  render();
}

function render() {
  write('input-error', '');
  const row = forecastRow(selectedWeek);
  const today = arizonaDay();
  const actual = currentWeek(today);
  write('week-title', 'Violet · Week ' + selectedWeek + (actual === selectedWeek ? ' · Current week' : ''));
  write('week-dates', date(row.start) + ' – ' + date(addDays(row.start, 6)));
  const ageDays = (selectedWeek - 1) * 7;
  write('week-age', Math.floor(ageDays / 7) + ' weeks old at the start of this week · Born Oct 25, 2026');
  get('today').disabled = selectedWeek === Math.min(52, actual);
  write('today', actual > 52 ? 'Last chart week' : 'Current week');
  write('chart-baseline', 'Your chart forecasts ' + row.bottle + ' mL per bottle × ' + row.feeds + ' feeds per day this week.');
  const base = totals(baseBottle, baseFeeds);
  const trial = totals(trialBottle, trialFeeds);
  write('bottle-result', number(trialBottle) + ' mL');
  write('bottle-difference', signed(trialBottle - baseBottle) + ' mL per feed');
  write('daily-result', number(trial.daily) + ' mL');
  write('daily-difference', signed(trial.daily - base.daily) + ' mL per day');
  write('weekly-result', number(trial.weekly) + ' mL');
  write('weekly-difference', signed(trial.weekly - base.weekly) + ' mL per week');
  write('container-result', trial.containers);
  write('container-difference', signed(trial.containers - base.containers) + ' whole containers per week');
  renderBand();
  renderSupply();
  renderMatrix();
  drawChart();
  for (const row of get('forecast-rows').children) row.className = Number(row.dataset.week) === selectedWeek ? 'selected' : '';
}

function renderBand() {
  const band = referenceBand(selectedWeek);
  write('reference-title', band.low + '–' + band.high + ' mL for this age');
  write('reference-status', trialBottle + ' mL · ' + (trialBottle < band.low ? 'Below range' : trialBottle > band.high ? 'Above range' : 'Within range'));
  get('reference-status').dataset.band = trialBottle < band.low ? 'below' : trialBottle > band.high ? 'above' : 'within';
  write('reference-coverage', band.coverage);
  get('reference-source').href = band.source;
  write('reference-source', band.sourceName);
  const max = Math.ceil(Math.max(200, band.high, baseBottle, trialBottle) * 1.15 / 50) * 50;
  get('reference-band').style.left = band.low / max * 100 + '%';
  get('reference-band').style.width = (band.high - band.low) / max * 100 + '%';
  get('base-marker').style.left = baseBottle / max * 100 + '%';
  get('trial-marker').style.left = trialBottle / max * 100 + '%';
  get('band-axis').setAttribute('aria-label', 'Published age guide ' + band.low + ' to ' + band.high + ' mL. Starting bottle ' + baseBottle + ' mL. What-if bottle ' + trialBottle + ' mL.');
  write('axis-max', max + ' mL');
  const daily = trialBottle * trialFeeds;
  get('daily-note').className = 'daily-note' + (daily > AAP_DAILY_ML ? ' above' : '');
  write('daily-note', daily > AAP_DAILY_ML
    ? number(daily) + ' mL per day is above the AAP’s usual general reference of about 960 mL. Discuss consistently higher intake with her pediatrician.'
    : 'This scenario is ' + trialBottle + ' mL × ' + trialFeeds + ' feeds = ' + number(daily) + ' mL per day. Use her cues and feeding plan when deciding what to offer.');
}

function renderSupply() {
  const weeks = Number(get('horizon').value) || 1;
  const base = totals(baseBottle, baseFeeds, weeks);
  const trial = totals(trialBottle, trialFeeds, weeks);
  write('supply-total', number(trial.volume) + ' mL · ' + trial.containers + ' whole 32-fl-oz containers');
  write('supply-note', weeks + (weeks === 1 ? ' week' : ' weeks') + ' at ' + trialBottle + ' mL × ' + trialFeeds + ' feeds per day. ' + signed(trial.volume - base.volume) + ' mL versus the starting pattern.');
}

function renderMatrix() {
  const feedCounts = [...new Set([Math.max(1, trialFeeds - 1), trialFeeds, Math.min(24, trialFeeds + 1)])];
  const bottleSizes = [...new Set([-20, -10, 0, 10, 20].map(delta => Math.max(1, Math.min(500, trialBottle + delta))))];
  const heading = node('tr');
  heading.append(node('th', 'mL / feed'));
  for (const count of feedCounts) {
    const th = node('th', count);
    th.append(node('small', 'feeds / day'));
    heading.append(th);
  }
  get('matrix-head').replaceChildren(heading);
  get('matrix-body').replaceChildren(...bottleSizes.map(bottle => {
    const row = node('tr');
    row.append(node('th', bottle + ' mL'));
    for (const feeds of feedCounts) {
      const daily = bottle * feeds;
      const cell = node('td');
      const button = node('button', number(daily), daily > AAP_DAILY_ML ? 'over' : '');
      button.type = 'button';
      button.dataset.bottle = bottle;
      button.dataset.feeds = feeds;
      button.setAttribute('aria-label', bottle + ' mL per bottle, ' + feeds + ' feeds, ' + daily + ' mL per day');
      button.setAttribute('aria-pressed', String(bottle === trialBottle && feeds === trialFeeds));
      cell.append(button);
      row.append(cell);
    }
    return row;
  }));
}

function drawChart() {
  const canvas = get('trend');
  const width = canvas.getBoundingClientRect().width || 320;
  const height = 256;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  const year = get('chart-view').value === 'year';
  const start = year ? 1 : Math.max(1, Math.min(45, selectedWeek - 3));
  const end = year ? 52 : start + 7;
  const left = 43, right = 14, top = 17, bottom = 33;
  chartWindow = { start, end, left, right, width };
  const rows = Array.from({ length: end - start + 1 }, (_, index) => forecastRow(start + index));
  const max = Math.ceil(Math.max(trialBottle, ...rows.map(row => Math.max(row.bottle, referenceBand(row.week).high))) / 50) * 50 + 25;
  const x = week => left + (week - start) / (end - start) * (width - left - right);
  const y = value => height - bottom - value / max * (height - top - bottom);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '12px system-ui';
  ctx.textAlign = 'right';
  for (let value = 0; value <= max; value += 50) {
    ctx.strokeStyle = '#d4b4e326';
    ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(width - right, y(value)); ctx.stroke();
    ctx.fillStyle = '#d2bfd8'; ctx.fillText(String(value), left - 7, y(value) + 4);
  }
  ctx.fillStyle = '#c296f02b';
  ctx.beginPath();
  rows.forEach((row, index) => { const point = [x(row.week), y(referenceBand(row.week).high)]; if (index === 0) ctx.moveTo(...point); else ctx.lineTo(...point); });
  [...rows].reverse().forEach(row => ctx.lineTo(x(row.week), y(referenceBand(row.week).low)));
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = '#c296f0'; ctx.lineWidth = 2.5; ctx.beginPath();
  rows.forEach((row, index) => { if (index === 0) ctx.moveTo(x(row.week), y(row.bottle)); else ctx.lineTo(x(row.week), y(row.bottle)); });
  ctx.stroke();
  ctx.strokeStyle = '#ffd0ba77'; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x(selectedWeek), top); ctx.lineTo(x(selectedWeek), height - bottom); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#C83803'; ctx.strokeStyle = '#ffc0a5'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x(selectedWeek), y(trialBottle), 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#d2bfd8'; ctx.textAlign = 'center';
  const ticks = year ? [1, 13, 26, 39, 52] : rows.map(row => row.week);
  for (const week of ticks) ctx.fillText('W' + week, x(week), height - 11);
  ctx.textAlign = 'left'; ctx.fillText('mL / feed', left, 11);
  const caption = 'Weeks ' + start + '–' + end + ' · Week ' + selectedWeek + ' chart ' + forecastRow(selectedWeek).bottle + ' mL · What if ' + trialBottle + ' mL.';
  write('trend-caption', caption);
  canvas.setAttribute('aria-label', caption + ' Shaded area shows the published age guides.');
}

function renderForecast() {
  get('forecast-rows').replaceChildren(...FORECAST.map((_, index) => {
    const row = forecastRow(index + 1);
    const tr = node('tr');
    tr.dataset.week = row.week;
    const week = node('th');
    const button = node('button', 'Week ' + row.week);
    button.type = 'button';
    button.dataset.week = row.week;
    week.append(button);
    tr.append(week);
    for (const value of [date(row.start), row.bottle, row.feeds, number(row.daily), number(row.weekly), row.containers]) tr.append(node('td', value));
    return tr;
  }));
}

function exportCSV() {
  const rows = [['Week', 'Sunday start', 'mL per feed', 'Feeds per day', 'mL per day', 'mL per week', 'Whole 32-US-fl-oz containers']];
  FORECAST.forEach((_, index) => {
    const row = forecastRow(index + 1);
    rows.push([row.week, row.start, row.bottle, row.feeds, row.daily, row.weekly, row.containers]);
  });
  const csv = rows.map(row => row.join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = node('a');
  link.href = url; link.download = 'violet-52-week-formula-forecast.csv';
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

get('week').replaceChildren(...FORECAST.map((_, index) => new Option('Week ' + (index + 1) + ' · ' + date(weekStart(index + 1)), index + 1)));
get('week').addEventListener('change', event => loadWeek(event.target.value));
get('week-slider').addEventListener('input', event => loadWeek(event.target.value));
get('today').addEventListener('click', () => loadWeek(Math.min(52, currentWeek())));
get('reset').addEventListener('click', () => loadWeek(selectedWeek));
for (const id of ['base-bottle', 'base-feeds', 'trial-bottle', 'trial-feeds']) get(id).addEventListener('input', readControls);
get('minus').addEventListener('click', () => { trialBottle = Math.max(1, trialBottle - 10); fillControls(); render(); });
get('plus').addEventListener('click', () => { trialBottle = Math.min(500, trialBottle + 10); fillControls(); render(); });
get('match').addEventListener('click', () => { trialBottle = baseBottle; trialFeeds = baseFeeds; fillControls(); render(); });
get('horizon').addEventListener('change', renderSupply);
get('chart-view').addEventListener('change', drawChart);
get('matrix-body').addEventListener('click', event => {
  const button = event.target.closest('button[data-bottle]');
  if (!button) return;
  trialBottle = Number(button.dataset.bottle);
  trialFeeds = Number(button.dataset.feeds);
  fillControls(); render();
});
get('forecast-rows').addEventListener('click', event => {
  const button = event.target.closest('button[data-week]');
  if (button) loadWeek(button.dataset.week);
});
get('trend').addEventListener('click', event => {
  const { start, end, left, right, width } = chartWindow;
  const point = event.clientX - get('trend').getBoundingClientRect().left;
  const week = Math.round(start + (point - left) / (width - left - right) * (end - start));
  loadWeek(Math.max(start, Math.min(end, week)));
});
get('download').addEventListener('click', exportCSV);
window.addEventListener('resize', drawChart);
renderForecast();
loadWeek(selectedWeek);
