import { afterEach, describe, expect, it, vi } from "vitest";
import { WEB_AGENTS, WebClient } from "./web.js";

const publicDNS = async () => [{ address: "93.184.216.34", family: 4 }];
afterEach(() => vi.useRealTimers());

describe("public web reading", () => {
  // Proves an in-flight page cannot refill forgotten cached text after a privacy fence.
  it("discards a page completed after cache invalidation", async () => {
    let release = () => {};
    let started = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const request = vi.fn(async () => {
      started();
      await waiting;
      return {
        status: 200,
        headers: { "content-type": "text/plain" },
        body: "private page",
      };
    });
    const web = new WebClient({ resolve: publicDNS, request });
    const pending = web.fetch("https://example.com/page");
    await loading;
    web.invalidate();
    release();
    await expect(pending).rejects.toThrow("memory fence");
    await web.fetch("https://example.com/page");
    expect(request).toHaveBeenCalledTimes(2);
  });
  // Proves a cooldown established during another request's DNS lookup is checked before its HTTP send.
  it("rechecks cooldowns after asynchronous DNS", async () => {
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lookups = 0;
    const request = vi.fn(async () => ({
      status: 429,
      headers: { "retry-after": "60" },
      body: "wait",
    }));
    const web = new WebClient({
      resolve: async () => {
        if (++lookups === 1) await paused;
        return publicDNS();
      },
      request,
    });
    const first = web.fetch("https://example.com/first");
    await expect(web.fetch("https://example.com/second")).rejects.toThrow(
      "429",
    );
    release();
    await expect(first).rejects.toThrow("retry deadline");
    expect(request).toHaveBeenCalledTimes(1);
  });

  // Proves a later short Retry-After cannot replace a longer outstanding deadline from a concurrent request.
  it("preserves the longest concurrent cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    let release = () => {};
    let sent = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const request = vi.fn(async (url: URL) => {
      if (url.pathname === "/short") {
        sent();
        await paused;
      }
      return {
        status: 429,
        headers: { "retry-after": url.pathname === "/short" ? "1" : "60" },
        body: "wait",
      };
    });
    const web = new WebClient({ resolve: publicDNS, request });
    const short = web.fetch("https://example.com/short");
    await started;
    await expect(web.fetch("https://example.com/long")).rejects.toThrow("429");
    release();
    await expect(short).rejects.toThrow("429");
    vi.setSystemTime(new Date("2026-10-19T12:00:02Z"));
    await expect(web.fetch("https://example.com/later")).rejects.toThrow(
      "retry deadline",
    );
    expect(request).toHaveBeenCalledTimes(2);
  });

  // Proves rate limits block subsequent requests to the same origin until the server's deadline.
  it.each(["60", "Mon, 19 Oct 2026 12:01:00 GMT"])(
    "honors Retry-After %s",
    async (retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          status: 429,
          headers: { "retry-after": retryAfter },
          body: "slow down",
        })
        .mockResolvedValue({
          status: 200,
          headers: { "content-type": "text/plain" },
          body: "ready",
        });
      const web = new WebClient({ resolve: publicDNS, request });
      await expect(web.fetch("https://example.com/first")).rejects.toThrow(
        "429",
      );
      await expect(web.fetch("https://example.com/second")).rejects.toThrow(
        /retry|Retry/,
      );
      expect(request).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date("2026-10-19T12:01:01Z"));
      expect((await web.fetch("https://example.com/second")).text).toBe(
        "ready",
      );
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  // Proves readable page text, links and continuation survive while page scripts never execute.
  it("reads a page with identifiable fallback agents and bounded continuation", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 403, headers: {}, body: "blocked" })
      .mockResolvedValueOnce({ status: 406, headers: {}, body: "blocked" })
      .mockResolvedValue({
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><head><title>Real title</title></head><body><nav>Navigation junk</nav><article><h1>Readable</h1><script>throw new Error("must not run")</script><p>Hello <a href="/source">source</a>.</p><p>${"continued ".repeat(900)}</p></article></body></html>`,
      });
    const web = new WebClient({ resolve: publicDNS, request });
    const page = await web.fetch("https://example.com/article");
    expect(page.title).toBe("Real title");
    expect(page.text).toContain("Hello source (https://example.com/source)");
    expect(page.text).not.toContain("Navigation junk");
    expect(page.text).not.toContain("must not run");
    expect(page.next_offset).toBe(4000);
    expect(request.mock.calls.map((call) => call[2])).toEqual([...WEB_AGENTS]);
    expect(page.user_agent).toContain("Patch/0.0.0 (Protocord; Node.js https;");
    expect(
      (await web.fetch("https://example.com/article", 4000)).text,
    ).toContain("continued");
    expect(request).toHaveBeenCalledTimes(3);
  });

  // Proves DDG search returns actual result URLs/snippets and distinguishes blocking from no matches.
  it("extracts DDG sources and reports a blocked search honestly", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: { "content-type": "text/html" },
        body: '<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">Example guide</a><div class="result__snippet">Actual snippet</div></div>',
      })
      .mockResolvedValue({ status: 202, headers: {}, body: "captcha" });
    const web = new WebClient({ resolve: publicDNS, request });
    expect(await web.search("test query")).toMatchObject({
      results: [
        {
          title: "Example guide",
          url: "https://example.com/guide",
          snippet: "Actual snippet",
        },
      ],
      sources: [{ kind: "search", url: "https://example.com/guide" }],
    });
    expect(request.mock.calls[0]?.[0].hostname).toBe("html.duckduckgo.com");
    await expect(web.search("another query")).rejects.toThrow("202");
  });

  // Proves raw IPs, private DNS answers and redirect targets cannot reach the transport.
  it("blocks non-public destinations on every hop", async () => {
    const request = vi.fn(async () => ({
      status: 302,
      headers: { location: "https://127.0.0.1/private" },
      body: "",
    }));
    const web = new WebClient({ resolve: publicDNS, request });
    await expect(web.fetch("https://127.0.0.1/")).rejects.toThrow(
      "public HTTPS",
    );
    expect(request).not.toHaveBeenCalled();
    await expect(web.fetch("https://example.com/")).rejects.toThrow(
      "public HTTPS",
    );
    expect(request).toHaveBeenCalledTimes(1);
    const privateWeb = new WebClient({
      resolve: async () => [{ address: "10.0.0.1", family: 4 }],
      request,
    });
    await expect(privateWeb.fetch("https://private.example/")).rejects.toThrow(
      "non-public",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});
