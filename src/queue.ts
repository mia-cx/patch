export type QueuePriority = "leave" | "manual" | "passive" | "background";

export type QueueOptions = {
  priority?: QueuePriority;
  bucketKey?: string;
  ttlMs?: number;
  /** Wait for all active work, then block other jobs until this task settles. */
  exclusive?: boolean;
};

type Job<T> = {
  task: () => Promise<T>;
  bucketKey: string;
  enqueuedAt: number;
  ttlMs?: number | undefined;
  exclusive: boolean;
  resolve: (value: T | undefined) => void;
  reject: (error: unknown) => void;
};

type AnyJob = Job<unknown>;

type Bucket = {
  jobs: AnyJob[];
};

const PRIORITIES: QueuePriority[] = [
  "leave",
  "manual",
  "passive",
  "background",
];
const DEFAULT_PRIORITY: QueuePriority = "manual";
const DEFAULT_BUCKET_KEY = "global";

export class GenerationQueue {
  private running = 0;
  private exclusiveRunning = false;
  private readonly exclusiveJobs: AnyJob[] = [];
  private readonly activeBuckets = new Set<string>();
  private readonly tiers = new Map(
    PRIORITIES.map((priority) => [priority, new TierQueue()]),
  );

  constructor(private readonly maxConcurrency: number) {}

  async add<T>(
    task: () => Promise<T>,
    options: QueueOptions = {},
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const priority = options.priority ?? DEFAULT_PRIORITY;
      const bucketKey = options.bucketKey ?? DEFAULT_BUCKET_KEY;
      const tier = this.tiers.get(priority) ?? this.tiers.get(DEFAULT_PRIORITY);
      if (!tier) throw new Error("Generation queue is missing default tier");

      const job: AnyJob = {
        task: task as () => Promise<unknown>,
        bucketKey,
        enqueuedAt: Date.now(),
        ttlMs: options.ttlMs,
        exclusive: options.exclusive ?? false,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      if (job.exclusive) this.exclusiveJobs.push(job);
      else tier.enqueue(bucketKey, job);
      this.schedule();
    });
  }

  private schedule(): void {
    while (this.running < this.maxConcurrency) {
      if (this.exclusiveRunning) return;
      if (this.exclusiveJobs.length > 0 && this.running > 0) return;
      const job = this.exclusiveJobs.shift() ?? this.nextJob();
      if (!job) return;

      if (isExpired(job)) {
        job.resolve(undefined);
        continue;
      }

      this.running += 1;
      this.exclusiveRunning = job.exclusive;
      this.activeBuckets.add(job.bucketKey);
      void this.run(job);
    }
  }

  private async run(job: AnyJob): Promise<void> {
    try {
      job.resolve(await job.task());
    } catch (error) {
      job.reject(error);
    } finally {
      this.running -= 1;
      if (job.exclusive) this.exclusiveRunning = false;
      this.activeBuckets.delete(job.bucketKey);
      this.schedule();
    }
  }

  private nextJob(): AnyJob | undefined {
    for (const priority of PRIORITIES) {
      const job = this.tiers.get(priority)?.dequeue(this.activeBuckets);
      if (job) return job;
    }

    return undefined;
  }
}

class TierQueue {
  private readonly buckets = new Map<string, Bucket>();
  private readonly order: string[] = [];
  private cursor = 0;

  enqueue(bucketKey: string, job: AnyJob): void {
    let bucket = this.buckets.get(bucketKey);
    if (!bucket) {
      bucket = { jobs: [] };
      this.buckets.set(bucketKey, bucket);
      this.order.push(bucketKey);
    }

    bucket.jobs.push(job);
  }

  dequeue(activeBuckets: ReadonlySet<string>): AnyJob | undefined {
    let checked = 0;

    while (this.order.length > 0 && checked < this.order.length) {
      if (this.cursor >= this.order.length) this.cursor = 0;

      const bucketKey = this.order[this.cursor];
      if (!bucketKey) {
        this.order.splice(this.cursor, 1);
        continue;
      }

      if (activeBuckets.has(bucketKey)) {
        this.cursor = (this.cursor + 1) % this.order.length;
        checked += 1;
        continue;
      }

      const bucket = this.buckets.get(bucketKey);
      const job = bucket?.jobs.shift();

      if (!bucket || bucket.jobs.length === 0) {
        this.buckets.delete(bucketKey);
        this.order.splice(this.cursor, 1);
      } else {
        this.cursor = (this.cursor + 1) % this.order.length;
      }

      if (job) return job;
    }

    return undefined;
  }
}

function isExpired(job: AnyJob): boolean {
  return job.ttlMs !== undefined && Date.now() - job.enqueuedAt > job.ttlMs;
}
