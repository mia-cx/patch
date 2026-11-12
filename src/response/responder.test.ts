import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request } from "node:https";
import type { Message } from "discord.js";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { ConversationContextStore } from "../conversation/store.js";
import type { ConversationMessage } from "../conversation/types.js";
import type { DiscordAdapter } from "../discord/adapter.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../llm/client.js";
import { respond } from "./responder.js";

const dnsLookup = vi.hoisted(() =>
  vi.fn<() => Promise<{ address: string; family: number }[]>>(),
);
vi.mock("node:dns/promises", () => ({ lookup: dnsLookup }));
vi.mock("node:https", () => ({ request: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  dnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Proves a dead generated link is withheld and feedback reaches regeneration.
describe("reply link validation", () => {
  it("regenerates a 404 reply before sending anything to Discord", async () => {
    mockHttp([404, 404]);
    const { sent, requests } = await runReply([
      { content: "https://clyp.it/does-not-exist" },
      { content: "i don't have that recording handy" },
    ]);

    expect(sent).toEqual(["i don't have that recording handy"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: "https://clyp.it/does-not-exist",
        }),
        expect.objectContaining({
          role: "user",
          content: expect.stringMatching(/404[\s\S]*rewrite/i),
        }),
      ]),
    );
  });

  // Proves inaccessible destinations are not mistaken for invented links.
  it.each([401, 403, 429, 500, 503])(
    "allows HTTP %i without regeneration",
    async (status) => {
      mockHttp([status]);
      const { sent, requests } = await runReply([
        { content: "https://example.com/private" },
      ]);
      expect(sent).toEqual(["https://example.com/private"]);
      expect(requests).toHaveLength(1);
    },
  );

  it.each([404, 405, 501])(
    "accepts a working GET when HEAD returns %i",
    async (status) => {
      mockHttp([status, 200]);
      const { sent, requests } = await runReply([
        { content: "https://example.com/media" },
      ]);
      expect(sent).toEqual(["https://example.com/media"]);
      expect(requests).toHaveLength(1);
      expect(request).toHaveBeenNthCalledWith(
        2,
        new URL("https://example.com/media"),
        expect.objectContaining({ method: "GET" }),
        expect.any(Function),
      );
    },
  );

  // Proves DNS absence triggers repair while temporary resolver failures do not.
  it.each(["ENOTFOUND", "EAI_AGAIN"])(
    "handles DNS %s conservatively",
    async (code) => {
      dnsLookup.mockRejectedValueOnce(
        Object.assign(new Error("DNS failed"), { code }),
      );
      const broken = code === "ENOTFOUND";
      const { sent, requests } = await runReply([
        { content: "https://unresolvable.example/recording" },
        { content: "can't find that recording" },
      ]);
      expect(sent).toEqual([
        broken
          ? "can't find that recording"
          : "https://unresolvable.example/recording",
      ]);
      expect(requests).toHaveLength(broken ? 2 : 1);
    },
  );

  // Proves bounded retries never leak the rejected draft or a broken replacement.
  it("rechecks replacements and stops after two unsuccessful regenerations", async () => {
    mockHttp([404, 404, 404, 404, 404, 404]);
    const { sent, requests } = await runReply([
      { content: "https://example.com/a" },
      { content: "https://example.com/b" },
      { content: "https://example.com/c" },
    ]);
    expect(requests).toHaveLength(3);
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain("https://");
  });

  it("follows redirects to a missing destination before regenerating", async () => {
    mockHttp([
      { status: 302, location: "https://example.com/missing" },
      404,
      404,
    ]);
    const { sent } = await runReply([
      { content: "https://example.com/short" },
      { content: "that link is gone" },
    ]);
    expect(sent).toEqual(["that link is gone"]);
  });

  // Proves model-supplied links cannot probe local services, including redirects.
  it.each(["127.0.0.1", "169.254.169.254", "[::ffff:127.0.0.1]", "[::1]"])(
    "leaves %s unverified without contacting it",
    async (host) => {
      const { sent } = await runReply([{ content: `https://${host}/private` }]);
      expect(sent).toEqual([`https://${host}/private`]);
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("does not follow a public redirect into a private network", async () => {
    mockHttp([{ status: 302, location: "https://127.0.0.1/admin" }]);
    const { sent } = await runReply([
      { content: "https://example.com/redirect" },
    ]);
    expect(sent).toEqual(["https://example.com/redirect"]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not request a hostname resolving to a private address", async () => {
    dnsLookup.mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const { sent } = await runReply([
      { content: "https://internal.example/admin" },
    ]);
    expect(sent).toEqual(["https://internal.example/admin"]);
    expect(request).not.toHaveBeenCalled();
  });

  // Proves slow DNS is inconclusive and cannot hold a reply indefinitely.
  it("bounds slow DNS checks without declaring the link broken", async () => {
    vi.useFakeTimers();
    // Node's native AbortSignal timer is outside Vitest's fake clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    dnsLookup.mockImplementation(() => new Promise(() => {}));
    const pending = runReply([{ content: "https://example.com/slow" }]);
    await vi.advanceTimersByTimeAsync(5_001);
    const { sent, requests } = await pending;
    expect(sent).toEqual(["https://example.com/slow"]);
    expect(requests).toHaveLength(1);
  });

  // Proves Discord URL wrappers do not cause false404s or duplicate requests.
  it("checks Markdown, autolinks and balanced URL parentheses once each", async () => {
    mockHttp([200, 200]);
    await runReply([
      {
        content:
          "[song](https://example.com/a_(live)). <https://example.com/b> https://example.com/b",
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      1,
      new URL("https://example.com/a_(live)"),
      expect.any(Object),
      expect.any(Function),
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      new URL("https://example.com/b"),
      expect.any(Object),
      expect.any(Function),
    );
  });
});

function mockHttp(statuses: (number | { status: number; location: string })[]) {
  vi.mocked(request).mockImplementation((_url, _options, onResponse) => {
    const req = new EventEmitter() as ClientRequest;
    req.end = vi.fn(() => {
      queueMicrotask(() => {
        const result = statuses.shift() ?? 200;
        onResponse?.({
          statusCode: typeof result === "number" ? result : result.status,
          headers:
            typeof result === "number" ? {} : { location: result.location },
          destroy: vi.fn(),
        } as unknown as IncomingMessage);
      });
      return req;
    });
    return req;
  });
}

async function runReply(replies: LlmResponse[]) {
  const sent: string[] = [];
  const requests: LlmRequest[] = [];
  const context: ConversationMessage = {
    id: "trigger",
    channelId: "dm",
    authorId: "human",
    authorName: "Mia",
    authorIsBot: false,
    content: "got any recordings?",
    timestamp: new Date("2026-11-08T00:00:00Z"),
    mentionsBot: false,
    attachments: [],
  };
  const adapter: DiscordAdapter = {
    botUserId: "patch",
    async fetchMessage() {
      throw new Error("Unexpected context fetch");
    },
    async sendTyping() {},
    async sendMessage(_channel, content) {
      sent.push(content);
      return { ...context, content, authorId: "patch" };
    },
    async sendReply() {
      throw new Error("Unexpected guild reply");
    },
  };
  const contextStore = new ConversationContextStore(":memory:");
  const llm = {
    async complete(input: LlmRequest) {
      const { signal: _signal, ...saved } = input;
      requests.push(structuredClone(saved));
      const reply = replies.shift();
      if (!reply) throw new Error("Unexpected generation");
      return reply;
    },
  } as unknown as LlmClient;
  await respond({
    adapter,
    message: {
      id: "trigger",
      channelId: "dm",
      inGuild: () => false,
    } as unknown as Message,
    botUserId: "patch",
    config: loadConfig({ DISCORD_TOKEN: "test", DISCORD_CLIENT_ID: "test" }),
    llm,
    logger: pino({ enabled: false }),
    contextStore,
    contextMessages: [context],
    // Link checks are independent of memory; keep this DM outside Remora.
    remoraScope: () => undefined,
  });
  contextStore.close();
  return { sent, requests };
}
