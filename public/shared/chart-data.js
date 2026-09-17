// Pure helpers that turn dashboard data into chart series. No DOM access, so they can be unit tested in Node.
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// 'YYYY-MM-DD' of the Asia/Dhaka calendar day the timestamp falls on.
export const dhakaDay = (iso) => DAY_FORMAT.format(new Date(iso));

function nextDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

// One point per day from the first to the last registration (days without any are filled with 0),
// each with that day's count and the running total.
export function registrationTimeline(participants) {
  if (!participants.length) return [];
  const perDay = new Map();
  for (const p of participants) {
    const day = dhakaDay(p.created_at);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const days = [...perDay.keys()].sort();
  const points = [];
  let total = 0;
  for (let day = days[0]; day <= days.at(-1); day = nextDay(day)) {
    const count = perDay.get(day) ?? 0;
    total += count;
    points.push({ day, count, total });
  }
  return points;
}

// Seat fill level, emptiest first. Matches the Suppliers/Factories status filter values.
export const COVERAGE_ORDER = ['missing', 'registered', 'full'];

export function coverageBreakdown(organisations, kind) {
  const counts = { missing: 0, registered: 0, full: 0 };
  for (const o of organisations) {
    if (o.kind === kind) counts[o.reg_status] += 1;
  }
  return { ...counts, total: counts.missing + counts.registered + counts.full };
}
