import { CronExpressionParser } from "cron-parser";

const YEAR_MS = 366 * 86_400_000;
// Gregorian century boundaries can put eight years between February 29 occurrences.
const CRON_SEARCH_MS = 8 * YEAR_MS;

/** Validate explicit cron/timezone input and calculate a bounded, deterministic next occurrence. */
export function nextFollowup(cron: string, timezone: string, after: number) {
  if (
    cron.length > 128 ||
    cron.trim().split(/\s+/).length !== 5 ||
    /(^|[^A-Z])H(?=$|[^A-Z])/i.test(cron)
  )
    throw new Error(
      "Supply a five-field cron expression without randomized H fields",
    );
  if (
    timezone.length > 100 ||
    !/^[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timezone)
  )
    throw new Error(
      "Supply an explicit IANA timezone, such as Europe/Amsterdam",
    );
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    throw new Error(
      "Supply an explicit IANA timezone, such as Europe/Amsterdam",
    );
  }
  try {
    return CronExpressionParser.parse(cron, {
      tz: timezone,
      currentDate: after,
      endDate: after + CRON_SEARCH_MS,
    })
      .next()
      .getTime();
  } catch {
    throw new Error(
      "Invalid cron expression or no occurrence within eight years",
    );
  }
}

/** Reject missing offsets and normalized invalid calendar dates before scheduling a one-off. */
export function parseFollowupTimestamp(value: string) {
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) throw new Error("Supply an ISO timestamp with timezone");
  const calendar = `${match[1]}:${match[2] ?? "00"}.${(match[3] ?? "").padEnd(3, "0")}Z`;
  const local = Date.parse(calendar);
  const at = Date.parse(value);
  if (
    !Number.isFinite(local) ||
    !Number.isFinite(at) ||
    new Date(local).toISOString() !== calendar
  )
    throw new Error("Supply a valid ISO calendar timestamp with timezone");
  return at;
}

/** Keep one-off callers' scheduling horizon unchanged. */
export function validateFollowupTime(at: number, now: number) {
  if (!Number.isSafeInteger(at) || at <= now || at > now + YEAR_MS)
    throw new Error("Follow-up must be within the next year");
}
