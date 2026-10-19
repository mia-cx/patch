import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessStore } from "./store.js";

const resources: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of resources.splice(0).reverse()) close();
});
function store(path = ":memory:") {
  const result = new HarnessStore(path);
  resources.push(() => result.close());
  return result;
}

describe("text workspace and durable actions", () => {
  // Proves a second process cannot commit forgetting between a fence check and a plaintext write.
  it.each(["generation", "display", "action"] as const)(
    "serializes %s plaintext against a concurrent privacy fence",
    async (kind) => {
      const dir = mkdtempSync(join(tmpdir(), "patch-epoch-"));
      resources.push(() => rmSync(dir, { recursive: true, force: true }));
      const path = join(dir, "harness.sqlite");
      const first = store(path);
      const second = store(path);
      const raw = {
        id: "generation-original:output",
        revision: 0,
        text: "private decoder output",
      };
      first.captureGeneration("principal", "bank", raw, true, 0);
      const match =
        kind === "generation"
          ? "INSERT OR IGNORE INTO harness_generations"
          : kind === "display"
            ? "INSERT OR IGNORE INTO harness_displays"
            : "UPDATE harness_calls SET status = 'complete'";
      const prepare = DatabaseSync.prototype.prepare;
      let attempted = false;
      let deferred = false;
      vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        if (!attempted && sql.includes(match)) {
          attempted = true;
          try {
            second.invalidateConversationData();
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("locked"))
              throw error;
            deferred = true;
          }
        }
        return prepare.call(this, sql);
      });
      if (kind === "generation")
        first.captureGeneration(
          "principal",
          "bank",
          { ...raw, id: "generation-next:output" },
          true,
          0,
        );
      if (kind === "display")
        first.associateDisplay(
          "principal",
          "bank",
          "message",
          0,
          "private formatted output",
          raw,
          0,
        );
      if (kind === "action")
        await first.mutate("bank", "message:0:0:action", "args", async () => ({
          text: "private tool result",
        }));
      expect(attempted).toBe(true);
      if (deferred) second.invalidateConversationData();
      const inspect = new DatabaseSync(path, { readOnly: true });
      resources.push(() => inspect.close());
      expect(
        inspect
          .prepare("SELECT raw FROM harness_generations WHERE raw IS NOT NULL")
          .all(),
      ).toEqual([]);
      expect(
        inspect
          .prepare("SELECT body FROM harness_displays WHERE body IS NOT NULL")
          .all(),
      ).toEqual([]);
      expect(
        inspect
          .prepare("SELECT result FROM harness_calls WHERE result IS NOT NULL")
          .all(),
      ).toEqual([]);
    },
  );

  // Proves edits and forgetting retire raw generations, transformed displays and late attempts without retry resurrection.
  it("persists redaction, revision floors and immutable generation ancestry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "patch-lineage-"));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "harness.sqlite");
    const first = new HarnessStore(path);
    const original = {
      id: "generation-first:output",
      revision: 0,
      text: "raw 😀",
    };
    const child = {
      id: "generation-second:output",
      revision: 0,
      text: "a later reply",
    };
    first.advanceObservationRevision("p", "bank", "human", 0);
    first.captureGeneration("p", "bank", original, true, 0, [
      { id: "human", revision: 0 },
    ]);
    first.captureGeneration("p", "bank", child, true, 0, [
      { id: original.id, revision: 0, reference: true },
    ]);
    first.associateDisplay("p", "bank", "discord", 0, "formatted", child, 0);
    first.close();
    const next = store(path);
    expect(next.displayParent("p", "bank", "discord", 0, "formatted")).toEqual(
      child,
    );
    expect(
      next.displayParent("other", "bank", "discord", 0, "formatted"),
    ).toBeUndefined();
    next.advanceObservationRevision("p", "bank", "human", 1);
    expect(next.generation("p", "bank", original.id)).toBeUndefined();
    expect(
      next.displayParent("p", "bank", "discord", 0, "formatted"),
    ).toBeUndefined();
    expect(
      next.captureGeneration("p", "bank", original, true, 0, [
        { id: "human", revision: 0 },
      ]),
    ).toBeUndefined();
    const late = next.mutate("bank", "source:1:0:test", "{}", async () => {
      next.invalidateConversationData();
      return { text: "late secret" };
    });
    await expect(late).rejects.toThrow("memory fence");
    expect(
      next.captureGeneration("p", "bank", child, true, 0, [
        { id: original.id, revision: 0, reference: true },
      ]),
    ).toBeUndefined();
    const inspect = new DatabaseSync(path, { readOnly: true });
    resources.push(() => inspect.close());
    expect(
      inspect
        .prepare("SELECT raw FROM harness_generations WHERE raw IS NOT NULL")
        .all(),
    ).toEqual([]);
    expect(
      inspect
        .prepare("SELECT body FROM harness_displays WHERE body IS NOT NULL")
        .all(),
    ).toEqual([]);
  });
  // Proves restarts retain cutover and exact context identities, while source conflicts and boundary rewinds fail locally.
  it("persists immutable observation boundaries and context manifests", () => {
    const dir = mkdtempSync(join(tmpdir(), "patch-observations-"));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "observations.sqlite");
    const first = new HarnessStore(path);
    expect(first.observationCutoff("bank:A", "100")).toBe(100n);
    const context = [
      { id: "message:12", revision: 1000, digest: "a".repeat(64) },
    ];
    expect(
      first.freezeObservation(
        "bank:A",
        "message:13",
        0,
        "b".repeat(64),
        context,
      ),
    ).toEqual(context);
    first.close();
    const next = store(path);
    expect(next.observationCutoff("bank:A", "100")).toBe(100n);
    expect(() => next.observationCutoff("bank:A", "90")).toThrow(
      "durable bank boundary",
    );
    expect(
      next.freezeObservation("bank:A", "message:13", 0, "b".repeat(64), []),
    ).toEqual(context);
    expect(() =>
      next.freezeObservation(
        "bank:A",
        "message:13",
        0,
        "c".repeat(64),
        context,
      ),
    ).toThrow("original revision");
    expect(
      next.freezeObservation("bank:A", "message:13", 1, "c".repeat(64), []),
    ).toEqual([]);
    expect(next.observationCutoff("bank:B", "200")).toBe(200n);
    expect(
      next.freezeObservation("bank:B", "message:13", 0, "d".repeat(64), []),
    ).toEqual([]);
  });

  // Proves scoped notes survive restart as literal text, with optimistic edits and no host paths.
  it("persists scoped text and rejects stale edits and host paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "patch-notes-"));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "notes.sqlite");
    const first = new HarnessStore(path);
    const receipt = first.writeNote(
      "dm:A",
      "research/ideas.md",
      "literal $(touch nope) and <script>code</script>",
      null,
    );
    first.close();
    const next = store(path);
    expect(next.readNote("dm:A", "research/ideas.md")).toEqual({
      path: "research/ideas.md",
      revision: receipt.revision,
      text: "literal $(touch nope) and <script>code</script>",
    });
    expect(() => next.readNote("dm:B", "research/ideas.md")).toThrow(
      "not found",
    );
    expect(() =>
      next.writeNote("dm:A", "research/ideas.md", "stale", null),
    ).toThrow("revision conflict");
    for (const name of [
      "../secret",
      "/etc/passwd",
      "a/../../b",
      "https://example.com",
      "a.js",
    ])
      expect(() => next.writeNote("dm:A", name, "no", null)).toThrow(
        "document name",
      );
    next.deleteNote("dm:A", "research/ideas.md", receipt.revision);
    expect(next.listNotes("dm:A")).toEqual([]);
  });

  // Proves completed mutations replay receipts and lost responses cannot repeat a side effect.
  it("replays completed actions and holds uncertain repeats across call positions", async () => {
    const db = store();
    const execute = vi.fn(async () => ({ message_id: "42" }));
    expect(
      await db.mutate("A", "1:0:0:react", "react:{}", execute),
    ).toMatchObject({ replayed: false });
    expect(
      await db.mutate("A", "1:0:1:react", "react:{}", execute),
    ).toMatchObject({ replayed: true, result: { message_id: "42" } });
    expect(execute).toHaveBeenCalledTimes(1);
    const lost = vi.fn(async () => {
      throw new Error("response lost after Discord accepted");
    });
    await expect(db.mutate("A", "2:0:0:edit", "edit:{}", lost)).rejects.toThrow(
      "response lost",
    );
    await expect(db.mutate("A", "2:0:1:edit", "edit:{}", lost)).rejects.toThrow(
      "uncertain",
    );
    expect(lost).toHaveBeenCalledTimes(1);
  });

  // Proves delivery claims survive restart without resend and privacy fences remove working copies.
  it("holds uncertain follow-ups and clears retained conversation material", () => {
    const dir = mkdtempSync(join(tmpdir(), "patch-followups-"));
    resources.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "jobs.sqlite");
    const first = new HarnessStore(path);
    const job = first.schedule("A", 2000, "check in", 1000);
    expect(first.claim(job.id)).toBe(true);
    first.close();
    const next = store(path);
    expect(next.due(3000)).toEqual([]);
    expect(next.followups("A")[0]?.status).toBe("uncertain");
    next.cancel("A", job.id);
    next.writeNote("A", "memory.md", "private working material", null);
    next.schedule("A", 4000, "private queued material", 1000);
    next.invalidateConversationData();
    expect(next.listNotes("A")).toEqual([]);
    expect(next.followups("A")).toEqual([]);
  });
});
