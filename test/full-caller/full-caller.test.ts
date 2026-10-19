import { describe, expect, it, vi } from "vitest";
import { evidenceCapabilities } from "../fixtures/evidence.js";
import { auditFullCaller } from "./audit.js";
import { BASE, MODEL } from "./fixture.js";
import { CallerHttpGuard } from "./guard.js";

describe("prepared full caller qualification", () => {
  // Proves the complete persona, all three tagged rounds, repair and display re-entry bind every nonblank scalar without real HTTP.
  it("audits complete real caller branches with invented responses", async () => {
    vi.useFakeTimers();
    const pending = auditFullCaller();
    await vi.runAllTimersAsync();
    const result = await pending;
    vi.useRealTimers();
    expect(result.persona).toContain("edit_message");
    expect(result.persona).toContain("scratch_write");
    expect(result.sharedPersona).toContain("start_thread");
    expect(result.report.tool_rounds).toBe(3);
    expect(result.report.actual_formatting_fallback).toBe(true);
    expect(result.required_limits.max_observation_sources).toBeGreaterThan(16);
  });

  // Proves observed audit maxima do not reject valid advertised-budget requests, and guard failures never reach HTTP.
  it("permits negotiated budgets and blocks foreign routes, tools and bank grants", async () => {
    const transport = vi.fn(async () => Response.json({ invented: true }));
    const guard = new CallerHttpGuard(
      transport,
      "invented",
      evidenceCapabilities.limits,
      () => {},
      new Set(["full persona"]),
    );
    const messages = [
      { role: "system", content: "full persona" },
      { role: "user", content: "x".repeat(40) },
    ];
    const body = {
      model: MODEL,
      messages,
      temperature: 0,
      max_tokens: 256,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
      remora: {
        read_banks: ["full-caller-v1-dm"],
        observations: {
          bank: "full-caller-v1-dm",
          id: "invented",
          revision: 0,
          inputs: Array.from({ length: 40 }, (_, i) => ({
            id: `input-${i}`,
            revision: 0,
            origin: "unattributed_input",
            views: [{ message_index: 1, start: i, end: i + 1 }],
          })),
        },
      },
    };
    const headers = { Authorization: "Bearer invented" };
    await guard.fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(guard.sources).toBe(40);
    for (const [url, value] of [
      ["http://127.0.0.1:18787/v1/chat/completions", body],
      [`${BASE}/chat/completions`, { ...body, tools: [{ type: "function" }] }],
      [
        `${BASE}/chat/completions`,
        {
          ...body,
          remora: { ...body.remora, read_banks: ["original-live-bank"] },
        },
      ],
    ] as const)
      await expect(
        guard.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(value),
        }),
      ).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
