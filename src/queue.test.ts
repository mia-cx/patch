import { describe, expect, it } from "vitest";
import { GenerationQueue } from "./queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("GenerationQueue", () => {
  // Proves memory mutations wait for every active reply and fence queued replies until completion.
  it("runs exclusive work between active and queued generations, releasing on failure", async () => {
    const queue = new GenerationQueue(2);
    const firstGate = deferred<void>();
    const secondGate = deferred<void>();
    const mutationGate = deferred<void>();
    const order: string[] = [];
    const first = queue.add(
      async () => {
        order.push("first");
        await firstGate.promise;
      },
      { bucketKey: "first" },
    );
    const second = queue.add(
      async () => {
        order.push("second");
        await secondGate.promise;
      },
      { bucketKey: "second" },
    );
    const mutation = queue.add(
      async () => {
        order.push("mutation");
        await mutationGate.promise;
        throw new Error("permission changed");
      },
      { exclusive: true },
    );
    const failedMutation =
      expect(mutation).rejects.toThrow("permission changed");
    const queued = queue.add(async () => order.push("queued"), {
      bucketKey: "third",
    });
    firstGate.resolve();
    await first;
    await Promise.resolve();
    expect(order).toEqual(["first", "second"]);
    secondGate.resolve();
    await second;
    await Promise.resolve();
    expect(order).toEqual(["first", "second", "mutation"]);
    mutationGate.resolve();
    await failedMutation;
    await queued;
    expect(order).toEqual(["first", "second", "mutation", "queued"]);
  });

  it("runs waiting manual jobs before passive and background jobs", async () => {
    const queue = new GenerationQueue(1);
    const gate = deferred<void>();
    const order: string[] = [];

    const first = queue.add(async () => {
      order.push("first");
      await gate.promise;
    });
    const background = queue.add(async () => order.push("background"), {
      priority: "background",
    });
    const passive = queue.add(async () => order.push("passive"), {
      priority: "passive",
    });
    const manual = queue.add(async () => order.push("manual"), {
      priority: "manual",
    });

    await Promise.resolve();
    gate.resolve();
    await Promise.all([first, background, passive, manual]);

    expect(order).toEqual(["first", "manual", "passive", "background"]);
  });

  it("round-robins between buckets within a priority", async () => {
    const queue = new GenerationQueue(1);
    const gate = deferred<void>();
    const order: string[] = [];

    const a1 = queue.add(
      async () => {
        order.push("a1");
        await gate.promise;
      },
      { bucketKey: "a" },
    );
    const a2 = queue.add(async () => order.push("a2"), { bucketKey: "a" });
    const b1 = queue.add(async () => order.push("b1"), { bucketKey: "b" });
    const a3 = queue.add(async () => order.push("a3"), { bucketKey: "a" });

    await Promise.resolve();
    gate.resolve();
    await Promise.all([a1, a2, b1, a3]);

    expect(order).toEqual(["a1", "a2", "b1", "a3"]);
  });

  it("drops expired jobs before they start", async () => {
    const queue = new GenerationQueue(1);
    const gate = deferred<void>();
    const order: string[] = [];

    const first = queue.add(async () => {
      order.push("first");
      await gate.promise;
    });
    const expired = queue.add(async () => order.push("expired"), {
      priority: "passive",
      ttlMs: 1,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    gate.resolve();
    await Promise.all([first, expired]);

    expect(order).toEqual(["first"]);
    await expect(expired).resolves.toBeUndefined();
  });

  it("does not run jobs from the same bucket concurrently", async () => {
    const queue = new GenerationQueue(2);
    const gates = [deferred<void>(), deferred<void>()];
    let running = 0;
    let maxRunning = 0;

    const first = queue.add(
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gates[0]?.promise;
        running -= 1;
      },
      { bucketKey: "thread" },
    );
    const second = queue.add(
      async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gates[1]?.promise;
        running -= 1;
      },
      { bucketKey: "thread" },
    );

    await Promise.resolve();
    expect(maxRunning).toBe(1);

    gates[0]?.resolve();
    await first;
    await Promise.resolve();
    expect(maxRunning).toBe(1);

    gates[1]?.resolve();
    await second;
    expect(maxRunning).toBe(1);
  });
});
