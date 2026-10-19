import { Schema } from "effect";
import { validateObservationBatch } from "../../src/llm/evidence.js";
import type { ObservationLimits } from "../../src/llm/evidence.js";
import { BANKS, BASE, MODEL } from "./fixture.js";

const Message = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
  content: Schema.String,
});
const Chat = Schema.Struct({
  model: Schema.Literal(MODEL),
  messages: Schema.Array(Message),
  temperature: Schema.Literal(0),
  max_tokens: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(256),
  ),
  cache_prompt: Schema.Boolean,
  chat_template_kwargs: Schema.Struct({
    enable_thinking: Schema.Literal(false),
  }),
  remora: Schema.Struct({
    read_banks: Schema.Array(Schema.String),
    speaker: Schema.optional(
      Schema.Struct({ bank: Schema.String, id: Schema.String }),
    ),
    observations: Schema.optional(Schema.Unknown),
    recall: Schema.optional(Schema.Unknown),
  }),
});

/** Closed outbound boundary. It records bodies and responses, never credentials. */
export class CallerHttpGuard {
  count = 0;
  completions = 0;
  sources = 0;
  views = 0;
  readonly chats: Array<ReturnType<CallerHttpGuard["chat"]>> = [];

  constructor(
    private readonly transport: typeof fetch,
    private readonly token: string,
    private readonly limits: ObservationLimits,
    private readonly record: (value: unknown) => void,
    private readonly persona: ReadonlySet<string>,
  ) {}

  private chat(value: unknown) {
    const body = Schema.decodeUnknownSync(Chat, { onExcessProperty: "error" })(
      value,
    );
    this.banks(body.remora);
    const observations =
      body.remora.observations === undefined
        ? undefined
        : validateObservationBatch(
            body.remora.observations,
            body.messages,
            this.limits,
          );
    const sources =
      (observations?.inputs.length ?? 0) +
      (observations?.references?.length ?? 0);
    const views = [
      ...(observations?.inputs ?? []),
      ...(observations?.references ?? []),
    ].reduce((total, source) => total + source.views.length, 0);
    this.sources = Math.max(this.sources, sources);
    this.views = Math.max(this.views, views);
    // Observed audit maxima describe the fixture, not a smaller runtime ceiling.
    // validateObservationBatch enforces the negotiated combined 128/512 limits.
    // Formatting repair has its own installed SYSTEM. All ordinary calls keep the exact full persona.
    if (
      !this.persona.has(body.messages[0]?.content ?? "") &&
      !body.messages[0]?.content.startsWith(
        "Repair Discord output formatting only. Preserve the exact words",
      )
    )
      throw new Error("Full assembled persona differs from the frozen caller");
    return { body, observations };
  }

  private banks(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) this.banks(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "bank" && !BANKS.some((bank) => bank === item))
        throw new Error("Nonfictional bank denied");
      if (
        key === "read_banks" &&
        (!Array.isArray(item) ||
          !item.length ||
          item.some((bank) => !BANKS.includes(bank)))
      )
        throw new Error("Nonfictional read scope denied");
      this.banks(item);
    }
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (typeof input !== "string")
      throw new Error("Qualification HTTP requires explicit string URL");
    const url = new URL(input);
    if (
      url.origin !== new URL(BASE).origin ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error("External HTTP denied");
    const method = init?.method ?? "GET";
    const read =
      method === "GET" &&
      [
        "/v1/remora/capabilities",
        "/v1/remora/evidence",
        "/v1/remora/memories",
      ].includes(url.pathname);
    const write =
      method === "POST" &&
      [
        "/v1/chat/completions",
        "/v1/remora/evidence/forget",
        "/v1/remora/evidence/forget-source",
        "/v1/remora/memories/forget",
        "/v1/remora/memories/clear",
      ].includes(url.pathname);
    if (!read && !write) throw new Error("Qualification HTTP route denied");
    if (
      new Headers(init?.headers).get("Authorization") !== `Bearer ${this.token}`
    )
      throw new Error("Qualification credential mismatch");
    if (++this.count > 63) throw new Error("Caller HTTP budget exhausted");
    let body: unknown;
    if (write) {
      if (url.search) throw new Error("POST query denied");
      body = JSON.parse(String(init?.body));
      if (url.pathname === "/v1/chat/completions") {
        if (++this.completions > 24)
          throw new Error("Caller completion budget exhausted");
        this.chats.push(this.chat(body));
      } else this.banks(body);
    } else if (url.pathname !== "/v1/remora/capabilities") {
      if (
        !BANKS.some((bank) => bank === url.searchParams.get("bank")) ||
        [...url.searchParams.keys()].some(
          (key) => !["bank", "limit", "cursor"].includes(key),
        )
      )
        throw new Error("Management query denied");
    } else if (url.search) throw new Error("Capabilities query denied");
    const response = await this.transport(input, {
      ...init,
      redirect: "error",
    });
    this.record({
      index: this.count,
      method,
      path: url.pathname + url.search,
      body,
      status: response.status,
      response: await response.clone().json(),
    });
    return response;
  };
}
