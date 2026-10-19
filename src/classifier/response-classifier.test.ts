import { ChannelType, Client } from "discord.js";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { toConversationMessage } from "../discord/discord-js-adapter.js";
import { classifyShouldRespond } from "./response-classifier.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const client = new Client({ intents: [] });
  const packet = {
    id: "1000000000000000003",
    channel_id: "1000000000000000001",
    type: 0,
    author: {
      id: "1000000000000000002",
      username: "Mia",
      discriminator: "0",
      avatar: null,
    },
    content: "patch, what do you think?",
    timestamp: "2026-10-19T12:00:00Z",
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    components: [],
  };
  vi.spyOn(client.rest, "get").mockImplementation(async (route) =>
    route === "/channels/1000000000000000001"
      ? {
          id: "1000000000000000001",
          type: ChannelType.DM,
          recipients: [],
        }
      : packet,
  );
  const channel = await client.channels.fetch("1000000000000000001");
  if (!channel?.isDMBased()) throw new Error("Missing DM channel");
  const message = await channel.messages.fetch(packet.id);
  const botUserId = "1000000000000000004";
  const config = loadConfig({
    DISCORD_TOKEN: "discord",
    DISCORD_CLIENT_ID: botUserId,
    LLM_BASE_URL: "https://gemma.invalid/v1",
    LLM_API_KEY: "private-remora-key",
    CLASSIFIER_BASE_URL: "http://127.0.0.1:18792/v1",
    CLASSIFIER_API_KEY: "classifier-only",
  });
  return {
    message,
    botUserId,
    config,
    contextMessages: [toConversationMessage(message, botUserId)],
    logger: pino({ level: "silent" }),
    llmTraceLogging: false,
  };
}

describe("System 1 response classification", () => {
  // Proves both choices use one typed request with the current speaker/text, without response-persona instructions or Remora credentials.
  it.each(["respond", "dont respond"] as const)(
    "routes %s through Laya with a decision question",
    async (choice) => {
      const app = await fixture();
      const request = vi.fn(async (_url: string, _init?: RequestInit) =>
        Response.json({
          answers: {
            response: {
              type: "choice",
              choice,
              confidence: 0.56,
              answer_confidence: 0.91,
            },
          },
          usage: { truncated: false },
        }),
      );
      vi.stubGlobal("fetch", request);
      await expect(classifyShouldRespond(app)).resolves.toEqual({
        shouldRespond: choice === "respond",
        confidence: 0.91,
        reason: choice,
      });
      expect(request).toHaveBeenCalledTimes(1);
      const captured = request.mock.calls[0];
      if (!captured) throw new Error("Missing classifier request");
      const [url, init] = captured;
      expect(url).toBe("http://127.0.0.1:18792/v1/systemone");
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer classifier-only",
      );
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body.questions.response.criteria)).toEqual([
        "respond",
        "dont respond",
      ]);
      expect(body.model).toBe("english");
      expect(body.max_len).toBe(8192);
      expect(body.head_max_len).toBe(512);
      expect(body.questions.response.instructions).toContain(
        "latest Discord message",
      );
      expect(body.questions.response.instructions).not.toContain("JSON");
      expect(body.state).toContain("Bot being considered: Patch");
      expect(body.state).toContain(
        "LATEST MESSAGE TO CLASSIFY:\nMia (human): patch, what do you think?",
      );
      expect(body).not.toHaveProperty("remora");
      expect(JSON.stringify(body)).not.toContain("private-remora-key");
    },
  );

  // Proves invalid decisions and truncated inputs cannot trigger a reply or a second Gemma/repair request.
  it.each([
    {
      answers: {
        response: { type: "choice", choice: "maybe", answer_confidence: 0.9 },
      },
      usage: { truncated: false },
    },
    {
      answers: {
        response: { type: "choice", choice: "respond", answer_confidence: 2 },
      },
      usage: { truncated: false },
    },
    {
      answers: {
        response: { type: "choice", choice: "respond", answer_confidence: 0.9 },
      },
      usage: { truncated: true },
    },
    {
      answers: {
        response: { type: "choice", choice: "respond", answer_confidence: 0.9 },
      },
      usage: {},
    },
  ])("stays silent on an unusable result %#", async (response) => {
    const app = await fixture();
    const request = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", request);
    await expect(classifyShouldRespond(app)).resolves.toEqual({
      shouldRespond: false,
      confidence: 0,
      reason: "classifier unavailable",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  // Proves an unavailable classifier abstains without falling back to the response model.
  it("does not repair or fall back after a server failure", async () => {
    const app = await fixture();
    const request = vi.fn(
      async () => new Response("private server details", { status: 503 }),
    );
    vi.stubGlobal("fetch", request);
    await expect(classifyShouldRespond(app)).resolves.toEqual({
      shouldRespond: false,
      confidence: 0,
      reason: "classifier unavailable",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  // Proves a server abstention cannot trigger a response even when respond is the winning label.
  it("honors an abstained choice", async () => {
    const app = await fixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          answers: {
            response: {
              type: "choice",
              choice: "respond",
              answer_confidence: 0.55,
              abstention: "abstained",
            },
          },
          usage: { truncated: false },
        }),
      ),
    );
    await expect(classifyShouldRespond(app)).resolves.toEqual({
      shouldRespond: false,
      confidence: 0.55,
      reason: "abstained",
    });
  });

  // Proves a human reply target remains visible instead of treating every "you" as the bot.
  it("includes the actual reply author's name", async () => {
    const app = await fixture();
    const current = app.contextMessages[0];
    if (!current) throw new Error("Missing current message");
    app.contextMessages = [
      {
        ...current,
        id: "1000000000000000005",
        authorId: "1000000000000000006",
        authorName: "Sam",
        content: "I live in Utrecht.",
      },
      {
        ...current,
        content: "You're near me then.",
        replyTo: {
          channelId: current.channelId,
          messageId: "1000000000000000005",
        },
      },
    ];
    const request = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({
        answers: {
          response: {
            type: "choice",
            choice: "dont respond",
            answer_confidence: 0.7,
          },
        },
        usage: { truncated: false },
      }),
    );
    vi.stubGlobal("fetch", request);
    expect((await classifyShouldRespond(app)).shouldRespond).toBe(false);
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.state).toContain("Sam (human): I live in Utrecht.");
    expect(body.state).toContain(
      "LATEST MESSAGE TO CLASSIFY:\nMia (human) replying to Sam: You're near me then.",
    );
  });
});
