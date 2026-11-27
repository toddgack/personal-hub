export const BIRTH = '2026-10-25';
export const DAY_MS = 86400000;
export const FL_OZ_ML = 29.5735295625;
export const CONTAINER_ML = 32 * FL_OZ_ML;
export const AAP_DAILY_ML = 960;
export const GUIDE_URL = 'https://www.albertahealthservices.ca/assets/info/nutrition/if-nfs-how-much-infant-formula-to-prepare-for-baby.pdf';
export const EARLY_GUIDE_URL = 'https://www.healthychildren.org/English/ages-stages/baby/formula-feeding/Pages/amount-and-schedule-of-formula-feedings.aspx';
export const LATE_GUIDE_URL = 'https://www.wechu.org/healthy-families/bottle-feeding';

// Per-feed mL and feeds per day transcribed from the supplied 52-week chart.
export const FORECAST = [
  [55,9], [65,9], [80,8], [90,8], [100,8], [110,7], [115,7],
  [120,7], [135,6], [140,6], [145,6], [145,6], [150,6],
  [150,6], [150,6], [150,6], [175,5], [175,5], [180,5],
  [180,5], [180,5], [185,5], [185,5], [185,5], [185,5], [185,5],
  [180,5], [180,5], [175,5], [175,5], [175,5], [170,5],
  [170,5], [170,5], [165,5], [165,5], [165,5], [165,5], [165,5],
  [200,4], [195,4], [195,4], [195,4], [190,4], [190,4],
  [185,4], [185,4], [185,4], [180,4], [180,4], [180,4], [180,4]
];

export function arizonaDay(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date).map(part => [part.type, part.value]));
  return parts.year + '-' + parts.month + '-' + parts.day;
}

export function addDays(day, count) {
  return new Date(Date.parse(day + 'T12:00:00Z') + count * DAY_MS).toISOString().slice(0, 10);
}

export function currentWeek(day = arizonaDay()) {
  return Math.max(1, 1 + Math.floor((Date.parse(day + 'T12:00:00Z') - Date.parse(BIRTH + 'T12:00:00Z')) / (7 * DAY_MS)));
}

export function weekStart(week) {
  return addDays(BIRTH, (week - 1) * 7);
}

export function forecastRow(week) {
  const [bottle, feeds] = FORECAST[week - 1];
  return { week, start: weekStart(week), bottle, feeds, ...totals(bottle, feeds) };
}

export function totals(bottle, feeds, weeks = 1) {
  const daily = bottle * feeds;
  const weekly = daily * 7;
  const volume = weekly * weeks;
  return { daily, weekly, volume, containers: Math.ceil(volume / CONTAINER_ML) };
}

export function referenceBand(week) {
  const ageDays = (week - 1) * 7;
  const start = weekStart(week);
  if (week === 1) return { low: 30, high: 60, coverage: 'First-week formula guide; needs change rapidly during these days.', source: EARLY_GUIDE_URL, sourceName: 'AAP first-week guide' };
  if (ageDays < 21) return { low: 60, high: 90, coverage: 'Published guide covering ages 1–2 weeks.', source: GUIDE_URL, sourceName: 'Alberta Health Services' };
  if (ageDays < 63) return { low: 90, high: 150, coverage: 'Published guide covering ages 3–8 weeks.', source: GUIDE_URL, sourceName: 'Alberta Health Services' };
  if (start < '2027-04-25') return { low: 120, high: 180, coverage: 'Published guide covering ages 2–5 months, applied to this week.', source: GUIDE_URL, sourceName: 'Alberta Health Services' };
  if (start < '2027-07-25') return { low: 120, high: 240, coverage: 'Published guide covering ages 6–8 months, applied to this week.', source: GUIDE_URL, sourceName: 'Alberta Health Services' };
  return { low: 180, high: 240, coverage: 'Published guide covering ages 9–12 months, applied to this week.', source: LATE_GUIDE_URL, sourceName: 'Windsor-Essex Public Health' };
}

export function bandPosition(bottle, band) {
  if (bottle < band.low) return 'Below the published guide';
  if (bottle > band.high) return 'Above the published guide';
  return 'Within the published guide';
}
