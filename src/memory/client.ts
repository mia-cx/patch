import { Schema } from "effect";
import type { Config } from "../config.js";
import { parseRemoraCapabilities } from "../llm/remora.js";

const SafeCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const MemoryId = SafeCount.check(Schema.isGreaterThan(0));
const StoredString = Schema.String.check(Schema.isMinLength(1));
const Bank = Schema.String.check(
  Schema.isPattern(/\S/u),
  Schema.makeFilter((value) => Array.from(value).length <= 256),
);
const Revision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const Cursor = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
  Schema.isMaxLength(1024),
);
const Actor = Schema.Struct({
  bank: StoredString,
  role: Schema.Literals(["human", "assistant"]),
  id: StoredString,
});
const EntityRef = Schema.Union([
  Schema.Struct({
    principal: StoredString,
    actor: Actor,
    description: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    principal: StoredString,
    entity: StoredString,
    description: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    principal: StoredString,
    unknown: StoredString,
    description: Schema.optional(Schema.String),
  }),
]);
const Memory = Schema.Struct({
  id: MemoryId,
  text: Schema.String,
  kind: Schema.Literals(["fact", "tombstone"]),
  source: Schema.Literals(["user", "confirmed", "self"]),
  subjects: Schema.Record(
    Schema.String.check(Schema.isPattern(/^@\{[0-9a-f]{64}\}$/u)),
    EntityRef,
  ),
});
const MemoryPage = Schema.Struct({
  object: Schema.Literal("remora.memory.list"),
  version: Schema.Literal(1),
  bank: Bank,
  revision: Revision,
  data: Schema.Array(Memory).check(Schema.isMaxLength(100)),
  next_cursor: Schema.NullOr(Cursor),
});
const SearchScore = Schema.Number.check(
  Schema.isGreaterThanOrEqualTo(-1),
  Schema.isLessThanOrEqualTo(1),
);
const SearchRequest = Schema.Struct({
  read_banks: Schema.Array(Bank).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8),
    Schema.isUnique(),
  ),
  query: Schema.String.check(
    Schema.isPattern(/\S/u),
    Schema.makeFilter((value) => Array.from(value).length <= 2048),
  ),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(50)),
  ),
  min_score: Schema.optional(SearchScore),
});
const SearchResponse = Schema.Struct({
  object: Schema.Literal("remora.memory.search"),
  version: Schema.Literal(1),
  query: SearchRequest.fields.query,
  read_banks: SearchRequest.fields.read_banks,
  data: Schema.Array(
    Schema.Struct({
      ...Memory.fields,
      bank: Bank,
      kind: Schema.Literal("fact"),
      source_actor: Schema.NullOr(EntityRef),
      score: SearchScore,
    }),
  ).check(Schema.isMaxLength(50)),
  revisions: Schema.Record(Bank, Revision),
});
const MutationReceipt = Schema.Struct({
  object: Schema.Literal("remora.memory.mutation"),
  version: Schema.Literal(1),
  bank: Bank,
  request_id: Bank,
  operation: Schema.Literals(["forget", "clear"]),
  replayed: Schema.Boolean,
  deleted_ids: Schema.NullOr(
    Schema.Array(MemoryId).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(100),
      Schema.isUnique(),
    ),
  ),
  deleted_count: SafeCount,
  dependent_suppression: Schema.Struct({
    bank: Bank,
    visible_active_count: SafeCount,
  }),
  revision: Revision,
  cache_invalidated: Schema.Literal(true),
  reset_required: Schema.Literal(true),
});
const ErrorBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.NullOr(Schema.String) }),
});
const decodePage = Schema.decodeUnknownSync(MemoryPage, {
  onExcessProperty: "error",
});
const decodeReceipt = Schema.decodeUnknownSync(MutationReceipt, {
  onExcessProperty: "error",
});
const decodeSearch = Schema.decodeUnknownSync(SearchResponse, {
  onExcessProperty: "error",
});

export type MemoryRecord = typeof Memory.Type;
export type MemorySnapshot = typeof MemoryPage.Type;
export type MemoryMutation = typeof MutationReceipt.Type;
export type MemorySearch = typeof SearchResponse.Type;
export type MemorySearchRequest = typeof SearchRequest.Type;
export type MemorySearchLimits = {
  results: number;
  banks: number;
  queryChars: number;
  queryTokens: number;
};
export type MemoryLimits = {
  pageSize: number;
  forgetIds: number;
  requestIdChars: number;
};
type ClientConfig = Pick<Config, "llmBaseUrl" | "llmApiKey" | "llmTimeoutMs">;
type MutationRequest = {
  bank: string;
  request_id: string;
  expected_revision: string;
};

/** A safe code for command presentation; server messages never become Discord output. */
export class MemoryManagementError extends Error {
  constructor(
    readonly code: string,
    readonly status = 0,
    options?: ErrorOptions,
  ) {
    super(`Remora memory request failed (${code})`, options);
  }
}

/** Bank administration and explicit recall. Never calls chat completion or infers a grant. */
export class RemoraMemoryClient {
  private initialized = false;
  private limits: MemoryLimits | undefined;
  private searchLimits: MemorySearchLimits | undefined;

  constructor(private readonly config: ClientConfig) {}

  /** Reuse the startup capability result, or negotiate lazily after Discord authorization. */
  async initialize(capabilities?: ReturnType<typeof parseRemoraCapabilities>) {
    this.initialized = false;
    this.limits = undefined;
    this.searchLimits = undefined;
    const caps =
      capabilities ??
      parseRemoraCapabilities(await this.request("/remora/capabilities"));
    const {
      max_memory_page_size,
      max_memory_forget_ids,
      max_memory_request_id_chars,
    } = caps.limits;
    if (caps.features.memory_management) {
      if (
        max_memory_page_size === undefined ||
        max_memory_forget_ids === undefined ||
        max_memory_request_id_chars === undefined
      )
        throw new Error("Remora memory management requires all three limits");
      this.limits = {
        pageSize: max_memory_page_size,
        forgetIds: max_memory_forget_ids,
        requestIdChars: max_memory_request_id_chars,
      };
    }
    if (caps.features.memory_search) {
      const {
        max_search_results,
        max_search_banks,
        max_search_query_chars,
        max_search_query_tokens,
      } = caps.limits;
      if (
        max_search_results === undefined ||
        max_search_banks === undefined ||
        max_search_query_chars === undefined ||
        max_search_query_tokens === undefined
      )
        throw new Error("Remora memory search requires all four limits");
      this.searchLimits = {
        results: max_search_results,
        banks: max_search_banks,
        queryChars: max_search_query_chars,
        queryTokens: max_search_query_tokens,
      };
    }
    this.initialized = true;
    return caps;
  }

  /** Actual advertised bounds, with older endpoints treated as unavailable. */
  async getLimits(): Promise<MemoryLimits> {
    if (!this.initialized) await this.initialize();
    if (!this.limits) throw new MemoryManagementError("unsupported_feature");
    return this.limits;
  }

  /** Availability without an HTTP request while assembling the model's tool catalogue. */
  get supportsSearch() {
    return this.searchLimits !== undefined;
  }

  /** Search has its own feature gate and does not require management/deletion support. */
  async getSearchLimits(): Promise<MemorySearchLimits> {
    if (!this.initialized) await this.initialize();
    if (!this.searchLimits)
      throw new MemoryManagementError("unsupported_feature");
    return this.searchLimits;
  }

  /** Read ranked, bank-qualified facts. Token limits and grants remain enforced by the server. */
  async search(
    request: MemorySearchRequest,
    signal?: AbortSignal,
  ): Promise<MemorySearch> {
    const input = Schema.decodeUnknownSync(SearchRequest, {
      onExcessProperty: "error",
    })(request);
    const limits = await this.getSearchLimits();
    const limit = input.limit ?? Math.min(10, limits.results);
    if (
      input.read_banks.length > limits.banks ||
      Array.from(input.query).length > limits.queryChars ||
      limit > limits.results
    )
      throw new MemoryManagementError("invalid_parameter");
    let result: MemorySearch;
    try {
      result = decodeSearch(
        await this.request(
          "/remora/memories/search",
          { method: "POST", body: JSON.stringify({ ...input, limit }) },
          signal,
        ),
      );
    } catch (error) {
      if (error instanceof MemoryManagementError) throw error;
      // Decoder diagnostics can contain untrusted fact text; only expose a safe code.
      throw new MemoryManagementError("invalid_response", 0, { cause: error });
    }
    const banks = [...input.read_banks].sort(compareBanks);
    if (
      result.query !== input.query ||
      JSON.stringify(result.read_banks) !== JSON.stringify(banks) ||
      JSON.stringify(Object.keys(result.revisions).sort(compareBanks)) !==
        JSON.stringify(banks) ||
      result.data.length > limit
    )
      throw new MemoryManagementError("invalid_response");
    const seen = new Set<string>();
    let previous: MemorySearch["data"][number] | undefined;
    for (const hit of result.data) {
      const key = JSON.stringify([hit.bank, hit.id]);
      if (
        !banks.includes(hit.bank) ||
        seen.has(key) ||
        hit.score < (input.min_score ?? -1) ||
        (previous &&
          (hit.score > previous.score ||
            (hit.score === previous.score &&
              (compareBanks(hit.bank, previous.bank) < 0 ||
                (hit.bank === previous.bank && hit.id <= previous.id)))))
      )
        throw new MemoryManagementError("invalid_response");
      seen.add(key);
      previous = hit;
    }
    return result;
  }

  /** Read one authorized snapshot page; the revision can also guard a mutation. */
  async list(
    bank: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<MemorySnapshot> {
    const limits = await this.getLimits();
    Schema.decodeUnknownSync(Bank)(bank);
    if (cursor !== undefined) Schema.decodeUnknownSync(Cursor)(cursor);
    const query = new URLSearchParams({ bank, limit: String(limits.pageSize) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const page = decodePage(
      await this.request(`/remora/memories?${query}`, {}, signal),
    );
    if (page.bank !== bank || page.data.length > limits.pageSize)
      throw new MemoryManagementError("invalid_response");
    let lastId = 0;
    for (const memory of page.data) {
      if (memory.id <= lastId)
        throw new MemoryManagementError("invalid_response");
      lastId = memory.id;
    }
    if (page.next_cursor && page.data.length === 0)
      throw new MemoryManagementError("invalid_response");
    return page;
  }

  /** Collect complete pages from one revision, bounded by the caller's attachment allowance and timeout. */
  async listAll(bank: string, maxBytes: number): Promise<MemorySnapshot> {
    const signal = AbortSignal.timeout(this.config.llmTimeoutMs);
    const first = await this.list(bank, undefined, signal);
    const data = [...first.data];
    const cursors = new Set<string>();
    let page = first;
    let bytes = Buffer.byteLength(JSON.stringify(page.data));
    while (true) {
      if (bytes > maxBytes) throw new MemoryManagementError("export_too_large");
      if (page.next_cursor === null)
        return { ...first, data, next_cursor: null };
      if (cursors.has(page.next_cursor))
        throw new MemoryManagementError("invalid_response");
      cursors.add(page.next_cursor);
      page = await this.list(bank, page.next_cursor, signal);
      if (page.revision !== first.revision)
        throw new MemoryManagementError("cursor_stale", 409);
      const lastId = data.at(-1)?.id ?? 0;
      if (page.data.some((memory) => memory.id <= lastId))
        throw new MemoryManagementError("invalid_response");
      bytes += Buffer.byteLength(JSON.stringify(page.data));
      data.push(...page.data);
    }
  }

  /** Delete only explicit roots, preserving the exact request body for durable HTTP retries. */
  async forget(
    request: MutationRequest & { ids: readonly number[] },
  ): Promise<MemoryMutation> {
    const limits = await this.getLimits();
    Schema.decodeUnknownSync(
      Schema.Array(MemoryId).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(limits.forgetIds),
        Schema.isUnique(),
      ),
    )(request.ids);
    return this.mutate(
      "forget",
      request,
      [...request.ids].sort((a, b) => a - b),
    );
  }

  /** Clear the explicitly selected bank; server read-all and forget-all grants remain mandatory. */
  async clear(request: MutationRequest): Promise<MemoryMutation> {
    return this.mutate("clear", request, null);
  }

  private async mutate(
    operation: "forget" | "clear",
    request: MutationRequest,
    ids: number[] | null,
  ): Promise<MemoryMutation> {
    const limits = await this.getLimits();
    Schema.decodeUnknownSync(Bank)(request.bank);
    Schema.decodeUnknownSync(Bank)(request.request_id);
    Schema.decodeUnknownSync(Revision)(request.expected_revision);
    if (Array.from(request.request_id).length > limits.requestIdChars)
      throw new MemoryManagementError("invalid_request_id");
    const body = {
      bank: request.bank,
      request_id: request.request_id,
      expected_revision: request.expected_revision,
      ...(ids === null ? {} : { ids }),
    };
    const receipt = decodeReceipt(
      await this.request(`/remora/memories/${operation}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    if (
      receipt.bank !== request.bank ||
      receipt.request_id !== request.request_id ||
      receipt.operation !== operation ||
      receipt.dependent_suppression.bank !== request.bank ||
      (ids === null
        ? receipt.deleted_ids !== null ||
          receipt.dependent_suppression.visible_active_count !== 0
        : JSON.stringify(receipt.deleted_ids) !== JSON.stringify(ids) ||
          receipt.deleted_count !== ids.length)
    )
      throw new MemoryManagementError("invalid_response");
    return receipt;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    signal = AbortSignal.timeout(this.config.llmTimeoutMs),
  ): Promise<unknown> {
    const response = await fetch(`${this.config.llmBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.config.llmApiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      // Non-JSON gateway errors still get a safe code; their HTML/body is never shown or logged.
      const body: unknown = await response.json().catch(() => null);
      const code = Schema.is(ErrorBody)(body) ? body.error.code : null;
      throw new MemoryManagementError(
        code ?? "memory_management_error",
        response.status,
      );
    }
    return response.json();
  }
}

function compareBanks(left: string, right: string) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
