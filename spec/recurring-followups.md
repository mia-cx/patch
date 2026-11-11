# Recurring fixed-text follow-ups

`schedule_followup` accepts either `{at, text}` or `{cron, timezone, text}`.
The one-off `at` is an ISO calendar timestamp with `Z` or an explicit offset.
Repeating jobs require a five-field cron expression and an explicit IANA timezone.
For example, `{cron: "0 9 * * 1-5", timezone: "Europe/Amsterdam", text: "Check the fictional build."}`
sends that exact text on weekday mornings in Amsterdam.

The invocation selects the conversation. Model arguments cannot select a channel,
server, user, or arbitrary destination. Delivery makes no model call and disables mentions.
Both native and tagged tools use the registered Protocord validators and durable mutation receipts.
Supplying both schedules, omitting the timezone, or adding destination fields fails validation.
Timezone inference is never permitted.

## Cron and limits

The maintained `cron-parser` dependency is pinned to 5.10.4.
Fields are minute, hour, day-of-month, month and day-of-week.
Its named months/weekdays, ranges, lists, steps and last/nth-day syntax are supported.
Day-of-month and day-of-week restrictions use OR semantics.
Macros, seconds fields and randomized `H` fields are rejected.
`UTC` is accepted; a numeric offset is not an IANA timezone.
The host's local timezone never supplies a default.

There are at most 20 active schedules per conversation, including sending and
uncertain jobs. Each recurrence occupies one slot and reuses one database row.
Text contains 1–2000 UTF-16 code units and cannot be whitespace-only.
Cron expressions allow 128 characters; timezone names allow 100.
The earliest possible recurring interval is one minute.
One-offs and the first recurring occurrence must fall within the next 366 days.
Later occurrences may be farther apart, such as February 29; each search has an eight-year bound.
The worker polls every 30 seconds and reads at most 20 due jobs per pass.

## Delivery, restart and cancellation

SQLite stores the cron expression, timezone, exact text and next occurrence in `at`.
An additive local migration adds nullable recurrence columns without replacing legacy rows.
The migration runs when `HarnessStore` opens; implementation checks use isolated temporary databases.
The settings database expects a single runtime owner, as before.

The worker claims the persisted ID and occurrence before sending.
Concurrent delivery passes and stale queued work cannot claim that occurrence twice.
The Discord nonce derives from both values, allowing distinct recurring sends while
deduplicating the SDK's HTTP retries for one occurrence.
Successful delivery preserves recurring text and advances the same row.
One-off delivery clears its text and marks it delivered.

After an outage, one overdue occurrence can send. The worker then skips missed ticks
and persists a next occurrence strictly after completion time. It never loops through a backlog.
Advancement first calculates from the persisted occurrence. If that result is overdue,
it searches again from completion time. This takes at most two cron searches.

An ambiguous Discord outcome pauses the entire schedule as `uncertain`.
A restart also moves any `sending` row to `uncertain`, because Discord may have accepted it.
Neither path retries automatically. Users can inspect and cancel the schedule.
An invalid future cron calculation also holds the schedule for inspection.

`list_followups` exposes `recurring`, `cron`, `timezone`, status, and `next_at` as ISO.
Its existing numeric `at` remains the stored occurrence in epoch milliseconds.
For an uncertain row, that occurrence is held and will not send automatically.
`cancel_followup` cancels the entire schedule and clears retained text.
It can stop a claimed job before sending. An already in-flight request may complete,
but its eventual response cannot rearm the cancelled schedule.
A memory privacy fence likewise cancels recurring jobs and clears text.

## Daylight saving behavior

Cron calculations follow `cron-parser` 5.10.4's forward traversal in the supplied zone.
A nonexistent hour shifts into the next valid hour. A repeated hour is skipped when
the traversal crosses the backward transition.
For daily `30 2 * * *` in Amsterdam:

- March 29, 2026 sends at 03:30 CEST, or `2026-03-29T01:30:00Z`.
- October 25, 2026 selects the first 02:30, or `2026-10-25T00:30:00Z`.
- A delayed October delivery at `01:00Z` still advances to October 26 at `01:30Z`.

A new search starting inside the second repeated hour can select an occurrence in
that hour. This also applies when skipped ticks require a search from completion time.
Persisted UTC occurrences and claims remain unique across both transitions.
Minute/hour wildcard expressions follow the same parser's traversal rules.

## Synthetic contract export

After committing a clean implementation, run:

```sh
pnpm exec tsx test/export-recurring-followups.ts /mnt/media/private/mia-voice-real-context-v1/tool-contracts/recurring-followups.json
```

The exporter extracts the actual tool schemas and runs native calls through the
real caller, Protocord, SQLite and Discord SDK with invented Discord responses.
It records successful scheduling, mutation replay, exact delivery, listing,
cancellation, one-off compatibility and validation errors. Every output is observed,
and assertions stop the export if the lifecycle fails.
Each dispatched example includes its runtime-derived response shape and exact native
tool message, including the outer receipt. Schedule/cancel mutations wrap action
results as `{result, replayed}`; list reads return the array directly.
Dispatched errors return `{name, output: {error}, completed: false, error}`.
Structural validation errors occur before dispatch and emit no tool-result message.
The artifact records full Patch/base/Protocord hashes and distinguishes implemented
behavior from proposals and live qualification. No model or Discord network call runs.
The regression suite also exercises tagged calls, DST, restart, limits and cancellation races.
The private artifact contains only synthetic text; no private messages enter the repository.
