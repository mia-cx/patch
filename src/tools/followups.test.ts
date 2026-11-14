import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOLLOWUP_CHANNEL,
  followupHarness,
} from "../../test/fixtures/followups.js";
import { deliverFollowups } from "./followups.js";
import { HarnessStore } from "./store.js";

const resources: Array<() => void> = [];
afterEach(() => {
  for (const close of resources.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function harness(path?: string) {
  const app = await followupHarness(path);
  resources.push(() => app.close());
  return app;
}

function clock(at: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
}

describe("recurring follow-ups through Protocord and synthetic Discord", () => {
  // Proves native and tagged callers schedule exactly one recurring job on replay, list its next tick, deliver literal text, and cancel all future ticks.
  it.each([true, false])(
    "executes the complete fixed-text lifecycle, native=%s",
    async (native) => {
      clock("2026-11-11T12:00:00Z");
      const app = await harness();
      expect(app.compactPrompt).toContain(
        "schedule_followup(at:string, text:string) | schedule_followup(cron:string, timezone:string, text:string)",
      );
      const args = {
        cron: "*/5 * * * *",
        timezone: "Europe/Amsterdam",
        text: "  synthetic <@123> 😀\nkeep exactly  ",
      };
      expect(await app.invoke("schedule_followup", args, native)).toMatchObject(
        {
          completed: true,
          output: {
            replayed: false,
            result: {
              at: "2026-11-11T12:05:00.000Z",
              cron: args.cron,
              timezone: args.timezone,
            },
          },
        },
      );
      expect(await app.invoke("schedule_followup", args, native)).toMatchObject(
        { completed: true, output: { replayed: true } },
      );
      const [job] = app.store.followups(FOLLOWUP_CHANNEL);
      if (!job) throw new Error("Missing scheduled job");
      expect(await app.invoke("list_followups", {}, native)).toMatchObject({
        output: [
          { id: job.id, recurring: true, next_at: "2026-11-11T12:05:00.000Z" },
        ],
      });
      vi.setSystemTime(new Date("2026-11-11T12:05:00Z"));
      const model = vi.spyOn(app.context.llm, "complete");
      await Promise.all([
        deliverFollowups(app.context),
        deliverFollowups(app.context),
      ]);
      expect(app.deliveries).toEqual([
        expect.objectContaining({
          content: args.text,
          allowed_mentions: { parse: [], replied_user: false },
          enforce_nonce: true,
        }),
      ]);
      expect(model).not.toHaveBeenCalled();
      expect(app.store.followups(FOLLOWUP_CHANNEL)[0]).toMatchObject({
        id: job.id,
        text: args.text,
        at: Date.parse("2026-11-11T12:10:00Z"),
        status: "pending",
      });
      vi.setSystemTime(new Date("2026-11-11T12:10:00Z"));
      await deliverFollowups(app.context);
      expect(app.deliveries).toHaveLength(2);
      expect(app.deliveries[0]).not.toMatchObject({
        nonce: (app.deliveries[1] as { nonce: string }).nonce,
      });
      expect(
        await app.invoke("cancel_followup", { id: job.id }, native),
      ).toMatchObject({
        completed: true,
        output: { result: { id: job.id, cancelled: true } },
      });
      vi.setSystemTime(new Date("2027-01-01T12:00:00Z"));
      await deliverFollowups(app.context);
      expect(app.deliveries).toHaveLength(2);
      expect(app.store.followups(FOLLOWUP_CHANNEL)).toEqual([]);
    },
  );

  // Proves the original {at,text} call and receipt still deliver once and retain no sent text.
  it("preserves one-off callers", async () => {
    clock("2026-11-11T12:00:00Z");
    const app = await harness();
    expect(
      await app.invoke("schedule_followup", {
        at: "2026-11-11T13:01:00+01:00",
        text: "once",
      }),
    ).toMatchObject({
      completed: true,
      output: { result: { at: "2026-11-11T12:01:00.000Z", status: "pending" } },
    });
    expect(await app.invoke("list_followups", {})).toMatchObject({
      output: [{ recurring: false, cron: null, timezone: null }],
    });
    vi.setSystemTime(new Date("2026-11-11T12:01:00Z"));
    await deliverFollowups(app.context);
    await deliverFollowups(app.context);
    expect(app.deliveries).toHaveLength(1);
    expect(app.store.followups(FOLLOWUP_CHANNEL)).toEqual([]);
  });

  // Proves malformed or destination-widening model arguments cannot create a schedule.
  it.each([
    {
      at: "2026-11-11T13:00:00Z",
      cron: "* * * * *",
      timezone: "UTC",
      text: "bad",
    },
    { cron: "* * * * *", text: "missing zone" },
    { timezone: "UTC", text: "missing schedule" },
    { cron: "* * * * *", timezone: "", text: "empty zone" },
    { at: "2026-11-11T13:00:00Z", timezone: "UTC", text: "extra zone" },
    { cron: "* * * * *", timezone: "UTC", text: "bad", channel_id: "999" },
    {
      at: null,
      cron: "* * * * *",
      timezone: "UTC",
      text: "null is not omission",
    },
    { cron: "* * * * *", timezone: "UTC", text: "x".repeat(2001) },
  ])("rejects conflicting schedules and excess arguments: %j", async (args) => {
    clock("2026-11-11T12:00:00Z");
    const app = await harness();
    await expect(app.invoke("schedule_followup", args)).rejects.toThrow();
    expect(app.store.followups(FOLLOWUP_CHANNEL)).toEqual([]);
  });

  // Proves cron/timezone/time bounds fail at the tool boundary without sending anything.
  it.each([
    [{ cron: "0 * * * * *", timezone: "UTC", text: "seconds" }, "five-field"],
    [{ cron: "H * * * *", timezone: "UTC", text: "random" }, "randomized"],
    [{ cron: "61 * * * *", timezone: "UTC", text: "range" }, "Invalid cron"],
    [
      { cron: "0 0 31 2 *", timezone: "UTC", text: "impossible" },
      "Invalid cron",
    ],
    [{ cron: "* * * * *", timezone: "Mars/Olympus", text: "zone" }, "IANA"],
    [{ cron: "* * * * *", timezone: "+01:00", text: "offset" }, "IANA"],
    [{ cron: "* * * * *", timezone: "UTC", text: "   " }, "1–2000"],
    [{ at: "2026-11-11T13:00:00", text: "no zone" }, "timezone"],
    [{ at: "2027-02-30T13:00:00Z", text: "invalid day" }, "valid ISO calendar"],
    [{ at: "2026-11-11 13:00Z", text: "not ISO" }, "ISO timestamp"],
    [
      { cron: "0 9 29 2 *", timezone: "UTC", text: "first tick too far" },
      "next year",
    ],
    [{ at: "2026-11-10T13:00:00Z", text: "past" }, "next year"],
    [{ at: "2028-11-10T13:00:00Z", text: "far" }, "next year"],
  ] as const)("rejects invalid values: %j", async (args, error) => {
    clock("2026-11-11T12:00:00Z");
    const app = await harness();
    expect(await app.invoke("schedule_followup", args)).toMatchObject({
      completed: false,
      output: { error: expect.stringContaining(error) },
    });
    expect(app.store.followups(FOLLOWUP_CHANNEL)).toEqual([]);
    expect(app.deliveries).toEqual([]);
  });

  // Proves sparse accepted recurrence keeps its later leap-day tick instead of pausing after the first delivery.
  it("advances leap-day schedules beyond the initial one-year creation bound", async () => {
    clock("2028-02-28T12:00:00Z");
    const app = await harness();
    const job = app.store.scheduleRecurring(
      FOLLOWUP_CHANNEL,
      "0 9 29 2 *",
      "UTC",
      "leap day",
    );
    expect(job.at).toBe("2028-02-29T09:00:00.000Z");
    vi.setSystemTime(new Date(job.at));
    await deliverFollowups(app.context);
    expect(app.deliveries).toHaveLength(1);
    expect(app.store.followups(FOLLOWUP_CHANNEL)[0]?.at).toBe(
      Date.parse("2032-02-29T09:00:00Z"),
    );
  });

  // Proves named weekdays work and both DST transitions produce fixed documented UTC instants, including a delayed fold delivery.
  it.each([
    [
      "2026-03-28T02:00:00Z",
      "2026-03-29T01:30:00Z",
      "2026-03-30T00:30:00Z",
      "30 2 * * *",
    ],
    [
      "2026-10-24T02:00:00Z",
      "2026-10-25T01:00:00Z",
      "2026-10-26T01:30:00Z",
      "30 2 * * *",
    ],
    [
      "2026-11-11T12:00:00Z",
      "2026-11-12T08:00:00Z",
      "2026-11-19T08:00:00Z",
      "0 9 * * THU",
    ],
  ])(
    "advances local-time cron across DST: %s",
    async (start, delivery, next, cron) => {
      clock(start);
      const app = await harness();
      const receipt = app.store.scheduleRecurring(
        FOLLOWUP_CHANNEL,
        cron,
        "Europe/Amsterdam",
        "DST",
      );
      if (cron === "30 2 * * *")
        expect(receipt.at).toBe(
          start.includes("03-28")
            ? "2026-03-29T01:30:00.000Z"
            : "2026-10-25T00:30:00.000Z",
        );
      vi.setSystemTime(new Date(delivery));
      await deliverFollowups(app.context);
      expect(app.deliveries).toHaveLength(1);
      expect(app.store.followups(FOLLOWUP_CHANNEL)[0]?.at).toBe(
        Date.parse(next),
      );
    },
  );

  // Proves restart preserves pending/advanced ticks and a long outage coalesces to one send without stale-claim replay.
  it("persists recurrence and skips missed ticks after restart", async () => {
    clock("2026-11-11T12:00:00Z");
    const dir = mkdtempSync(join(tmpdir(), "recurring-followups-"));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "jobs.sqlite");
    const before = new HarnessStore(path);
    const job = before.scheduleRecurring(
      FOLLOWUP_CHANNEL,
      "* * * * *",
      "UTC",
      "after outage",
    );
    before.close();
    const app = await harness(path);
    expect(app.store.followups(FOLLOWUP_CHANNEL)[0]?.at).toBe(
      Date.parse("2026-11-11T12:01:00Z"),
    );
    vi.setSystemTime(new Date("2027-05-11T12:00:00Z"));
    await deliverFollowups(app.context);
    await deliverFollowups(app.context);
    expect(app.deliveries).toHaveLength(1);
    expect(app.store.followups(FOLLOWUP_CHANNEL)[0]).toMatchObject({
      at: Date.parse("2027-05-11T12:01:00Z"),
      text: "after outage",
    });
    const restarted = new HarnessStore(path);
    resources.push(() => restarted.close());
    expect(restarted.followups(FOLLOWUP_CHANNEL)[0]?.at).toBe(
      Date.parse("2027-05-11T12:01:00Z"),
    );
    vi.setSystemTime(new Date("2027-05-11T12:02:00Z"));
    expect(restarted.claim(job.id, Date.parse(job.at))).toBe(false);
    const current = Date.parse("2027-05-11T12:01:00Z");
    expect(restarted.claim(job.id, current)).toBe(true);
    restarted.finish(job.id, "stale receipt", Date.now(), Date.parse(job.at));
    expect(restarted.sending(job.id, current)).toBe(true);
    restarted.cancel(FOLLOWUP_CHANNEL, job.id);
    await deliverFollowups(app.context);
    expect(app.deliveries).toHaveLength(1);
  });

  // Proves an accepted-but-lost response or crashed claim pauses all future sends until cancellation, including after restart.
  it.each(["lost response", "crash"])(
    "holds ambiguous recurring deliveries: %s",
    async (failure) => {
      clock("2026-11-11T12:00:00Z");
      const dir = mkdtempSync(join(tmpdir(), "uncertain-followups-"));
      resources.push(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, "jobs.sqlite");
      const app = await harness(path);
      const job = app.store.scheduleRecurring(
        FOLLOWUP_CHANNEL,
        "* * * * *",
        "UTC",
        "hold",
      );
      vi.setSystemTime(new Date("2026-11-11T12:01:00Z"));
      const post = vi.spyOn(app.client.rest, "post");
      if (failure === "crash") app.store.claim(job.id);
      else {
        post.mockRejectedValue(new Error("response lost after acceptance"));
        await deliverFollowups(app.context);
        expect(post).toHaveBeenCalledTimes(1);
      }
      const restarted = new HarnessStore(path);
      resources.push(() => restarted.close());
      expect(restarted.followups(FOLLOWUP_CHANNEL)[0]?.status).toBe(
        "uncertain",
      );
      vi.setSystemTime(new Date("2027-01-01T12:00:00Z"));
      post.mockClear();
      await deliverFollowups(app.context);
      expect(post).not.toHaveBeenCalled();
      restarted.cancel(FOLLOWUP_CHANNEL, job.id);
      expect(restarted.followups(FOLLOWUP_CHANNEL)).toEqual([]);
    },
  );

  // Proves cancelling an already in-flight send allows its response to finish but never rearms the schedule.
  it("does not rearm recurrence after cancellation during send", async () => {
    clock("2026-11-11T12:00:00Z");
    const app = await harness();
    const job = app.store.scheduleRecurring(
      FOLLOWUP_CHANNEL,
      "* * * * *",
      "UTC",
      "in flight",
    );
    vi.setSystemTime(new Date("2026-11-11T12:01:00Z"));
    const post = app.client.rest.post.bind(app.client.rest);
    vi.spyOn(app.client.rest, "post").mockImplementation(async (...args) => {
      app.store.cancel(FOLLOWUP_CHANNEL, job.id);
      return post(...args);
    });
    await deliverFollowups(app.context);
    vi.setSystemTime(new Date("2026-11-11T12:05:00Z"));
    await deliverFollowups(app.context);
    expect(app.deliveries).toHaveLength(1);
    expect(app.store.followups(FOLLOWUP_CHANNEL)).toEqual([]);
  });

  // Proves cancellation and memory fences during lookup stop claimed sends and cannot resurrect recurrence.
  it.each(["cancel", "privacy fence"])(
    "stops a claimed job before send: %s",
    async (operation) => {
      clock("2026-11-11T12:00:00Z");
      const app = await harness();
      const job = app.store.scheduleRecurring(
        FOLLOWUP_CHANNEL,
        "* * * * *",
        "UTC",
        "private",
      );
      vi.setSystemTime(new Date("2026-11-11T12:01:00Z"));
      const fetch = app.client.channels.fetch.bind(app.client.channels);
      vi.spyOn(app.client.channels, "fetch").mockImplementation(
        async (...args) => {
          if (operation === "cancel")
            app.store.cancel(FOLLOWUP_CHANNEL, job.id);
          else app.store.invalidateConversationData();
          return fetch(...args);
        },
      );
      await deliverFollowups(app.context);
      expect(app.deliveries).toEqual([]);
      expect(app.store.followups(FOLLOWUP_CHANNEL)).toEqual([]);
    },
  );

  // Proves migration preserves a real pre-recurrence one-off row and all active states consume the same bounded quota.
  it("migrates legacy storage and bounds active schedules across states and scopes", async () => {
    clock("2026-11-11T12:00:00Z");
    const dir = mkdtempSync(join(tmpdir(), "legacy-followups-"));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "jobs.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(
      "CREATE TABLE harness_followups (id TEXT PRIMARY KEY, scope TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', message_id TEXT) STRICT",
    );
    legacy
      .prepare(
        "INSERT INTO harness_followups VALUES (?, ?, ?, ?, 'pending', NULL)",
      )
      .run("legacy", FOLLOWUP_CHANNEL, Date.now() + 60_000, "once");
    legacy.close();
    const app = await harness(path);
    expect(app.store.followups(FOLLOWUP_CHANNEL)[0]).toMatchObject({
      id: "legacy",
      text: "once",
      cron: null,
      timezone: null,
    });
    for (let i = 0; i < 19; i++)
      app.store.scheduleRecurring(
        FOLLOWUP_CHANNEL,
        "* * * * *",
        "UTC",
        "bounded",
      );
    vi.setSystemTime(new Date("2026-11-11T12:01:00Z"));
    const [first, second] = app.store.followups(FOLLOWUP_CHANNEL);
    if (!first || !second) throw new Error("Missing quota fixtures");
    app.store.claim(first.id);
    app.store.claim(second.id);
    app.store.finish(second.id);
    expect(
      await app.invoke("schedule_followup", {
        cron: "* * * * *",
        timezone: "UTC",
        text: "over limit",
      }),
    ).toMatchObject({
      completed: false,
      output: { error: "This conversation already has 20 active follow-ups" },
    });
    expect(() => app.store.cancel("other conversation", first.id)).toThrow(
      "not found",
    );
    expect(() =>
      app.store.scheduleRecurring(
        "other conversation",
        "* * * * *",
        "UTC",
        "independent",
      ),
    ).not.toThrow();
    app.store.cancel(FOLLOWUP_CHANNEL, first.id);
    expect(() =>
      app.store.schedule(FOLLOWUP_CHANNEL, Date.now() + 60_000, "free slot"),
    ).not.toThrow();
  });
});
