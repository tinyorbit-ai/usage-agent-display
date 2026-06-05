/**
 * Spend projection (phase 3, ADR 0009): linear extrapolation from the fraction of the
 * period elapsed. EOD = today's spend / (fraction of today elapsed); month = MTD spend
 * / (fraction of month elapsed). Everything is reckoned in the declared timezone so it
 * agrees with the month-to-date rollup. Early in a period the fraction is tiny, so we
 * clamp: below `MIN_FRACTION` we just return the spend so far (no wild divide-by-near-zero).
 */
const MIN_FRACTION = 1 / 1440; // one minute into the period

interface TzParts {
  year: number;
  month: number; // 1-based
  day: number;
  secondsOfDay: number;
}

function tzParts(nowMs: number, timezone: string): TzParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const hour = get("hour") % 24; // some engines emit "24" at midnight
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    secondsOfDay: hour * 3600 + get("minute") * 60 + get("second"),
  };
}

/** `YYYY-MM-DD` for an instant in the declared timezone. */
export function reckoningDay(nowMs: number, timezone: string): string {
  const p = tzParts(nowMs, timezone);
  const mm = String(p.month).padStart(2, "0");
  const dd = String(p.day).padStart(2, "0");
  return `${p.year}-${mm}-${dd}`;
}

export function fractionOfDay(nowMs: number, timezone: string): number {
  return tzParts(nowMs, timezone).secondsOfDay / 86_400;
}

export function fractionOfMonth(nowMs: number, timezone: string): number {
  const p = tzParts(nowMs, timezone);
  const daysInMonth = new Date(Date.UTC(p.year, p.month, 0)).getUTCDate();
  return (p.day - 1 + p.secondsOfDay / 86_400) / daysInMonth;
}

/** Extrapolate `spendSoFar` over a period that is `fraction` elapsed. */
export function project(spendSoFar: number, fraction: number): number {
  if (fraction < MIN_FRACTION) return spendSoFar; // too early to project meaningfully
  return spendSoFar / fraction;
}
