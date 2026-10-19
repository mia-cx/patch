import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { createBrotliDecompress, createUnzip } from "node:zlib";
import ipaddr from "ipaddr.js";
import { parseHTML } from "linkedom";

const MAX_BYTES = 2_000_000;
const PAGE_CHARS = 4_000;
const IDENTITY =
  "Patch/0.0.0 (Protocord; Node.js https; +https://github.com/mia-cx/patch)";
export const WEB_AGENTS = [
  IDENTITY,
  `Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0 ${IDENTITY}`,
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ${IDENTITY}`,
] as const;

type Address = { address: string; family: number };
type PageResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};
type Transport = (
  url: URL,
  address: Address,
  agent: string,
  signal: AbortSignal,
) => Promise<PageResponse>;
export type WebSource = { title: string; url: string; kind: "search" | "page" };

/** Public HTTPS only, with DNS pinned to the validated peer and no browser/script execution. */
export class WebClient {
  private epoch = 0;
  private readonly retryDeadlines = new Map<string, number>();
  private readonly cache = new Map<
    string,
    { time: number; title: string; url: string; text: string; agent: string }
  >();
  constructor(
    private readonly network: {
      resolve: (host: string) => Promise<Address[]>;
      request: Transport;
    } = {
      resolve: (host) => lookup(host, { all: true }),
      request: requestPage,
    },
  ) {}

  /** Forgetting invalidates cached page text and prevents an in-flight read refilling it. */
  invalidate() {
    this.epoch++;
    this.cache.clear();
  }

  async search(
    query: string,
    options: {
      recency?: "day" | "week" | "month" | "year" | undefined;
      domains?: readonly string[] | undefined;
    } = {},
    signal?: AbortSignal,
  ) {
    if (!query.trim() || query.length > 500)
      throw new Error("Search query must contain 1–500 characters");
    const url = new URL("https://html.duckduckgo.com/html/");
    const domains = options.domains ?? [];
    if (
      domains.length > 5 ||
      domains.some((domain) => !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(domain))
    )
      throw new Error("Search domains must be up to five hostnames");
    url.searchParams.set(
      "q",
      domains.length
        ? `${query} (${domains.map((domain) => `site:${domain}`).join(" OR ")})`
        : query,
    );
    if (options.recency)
      url.searchParams.set(
        "df",
        { day: "d", week: "w", month: "m", year: "y" }[options.recency],
      );
    const page = await this.load(url, signal);
    const { document } = parseHTML(page.body);
    const results = [...document.querySelectorAll(".result")]
      .flatMap((node) => {
        const link = node.querySelector(".result__a");
        if (!link) return [];
        const href = new URL(link.getAttribute("href") ?? "", page.url);
        const target = new URL(href.searchParams.get("uddg") ?? href.href);
        if (target.protocol !== "https:" || target.username || target.password)
          return [];
        return [
          {
            title: link.textContent?.trim() ?? target.hostname,
            url: target.href,
            snippet:
              node
                .querySelector(".result__snippet")
                ?.textContent?.trim()
                .slice(0, 600) ?? "",
          },
        ];
      })
      .slice(0, 6);
    if (
      !results.length &&
      !document.querySelector(".no-results, .result--no-result")
    )
      throw new Error(
        "DuckDuckGo blocked or changed its search page; no results were fabricated",
      );
    return {
      query,
      results,
      user_agent: page.agent,
      sources: results.map(({ title, url }) => ({
        title,
        url,
        kind: "search" as const,
      })),
    };
  }

  async fetch(urlString: string, offset = 0, signal?: AbortSignal) {
    const epoch = this.epoch;
    const url = this.validateURL(urlString);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid page offset");
    let page = this.cache.get(url.href);
    if (!page || Date.now() - page.time > 300_000) {
      const response = await this.load(url, signal);
      if (epoch !== this.epoch)
        throw new Error("Web result invalidated by a memory fence");
      const type = String(response.headers["content-type"] ?? "")
        .split(";")[0]
        ?.trim();
      let title = response.url;
      let text = response.body;
      if (type === "text/html" || type === "application/xhtml+xml") {
        const { document } = parseHTML(text);
        title = document.title?.trim() || title;
        for (const node of document.querySelectorAll(
          "script,style,nav,footer,header,aside,form,iframe,noscript",
        ))
          node.remove();
        const main =
          document.querySelector("article, main, [role=main]") ?? document.body;
        for (const link of main.querySelectorAll("a[href]")) {
          try {
            const href = new URL(link.getAttribute("href") ?? "", response.url);
            if (href.protocol === "https:")
              link.textContent = `${link.textContent} (${href.href})`;
          } catch {
            /* An invalid page link is not an instruction to fetch it. */
          }
        }
        text = main.innerText;
      } else if (!type?.startsWith("text/plain") && type !== "text/markdown")
        throw new Error(`Unsupported page format: ${type || "unknown"}`);
      text = text
        .replaceAll(/\n[ \t]+/g, "\n")
        .replaceAll(/\n{3,}/g, "\n\n")
        .trim();
      page = {
        title,
        text,
        url: response.url,
        agent: response.agent,
        time: Date.now(),
      };
      if (this.cache.size >= 20)
        this.cache.delete(this.cache.keys().next().value ?? "");
      this.cache.set(url.href, page);
    }
    if (offset > page.text.length)
      throw new Error("Page offset is past the end");
    return {
      title: page.title,
      url: page.url,
      text: page.text.slice(offset, offset + PAGE_CHARS),
      next_offset:
        offset + PAGE_CHARS < page.text.length ? offset + PAGE_CHARS : null,
      user_agent: page.agent,
      sources: [{ title: page.title, url: page.url, kind: "page" as const }],
    };
  }

  private validateURL(value: string) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      isIP(url.hostname.replaceAll(/[\[\]]/g, "")) ||
      (url.port && url.port !== "443")
    )
      throw new Error(
        "Only public HTTPS hostnames without credentials are allowed",
      );
    url.hash = "";
    return url;
  }

  private checkRetryDeadline(origin: string) {
    for (const [host, deadline] of this.retryDeadlines)
      if (deadline <= Date.now()) this.retryDeadlines.delete(host);
    const deadline = this.retryDeadlines.get(origin);
    if (deadline && deadline > Date.now())
      throw new Error(
        `Website retry deadline: wait ${Math.ceil((deadline - Date.now()) / 1000)} seconds`,
      );
  }

  private async load(initial: URL, parent?: AbortSignal) {
    const signal = parent
      ? AbortSignal.any([parent, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000);
    for (const agent of WEB_AGENTS) {
      let url = initial;
      for (let redirect = 0; redirect <= 5; redirect++) {
        signal.throwIfAborted();
        this.validateURL(url.href);
        this.checkRetryDeadline(url.origin);
        let onAbort: () => void = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const addresses = await Promise.race([
          this.network.resolve(url.hostname),
          aborted,
        ]).finally(() => signal.removeEventListener("abort", onAbort));
        signal.throwIfAborted();
        if (
          !addresses.length ||
          addresses.some(
            ({ address }) => ipaddr.process(address).range() !== "unicast",
          )
        )
          throw new Error("Web access to non-public addresses is blocked");
        const address = addresses[0];
        if (!address) throw new Error("Hostname has no address");
        this.checkRetryDeadline(url.origin);
        const response = await this.network.request(
          url,
          address,
          agent,
          signal,
        );
        const retryAfter = response.headers["retry-after"];
        if (
          response.status === 429 ||
          (response.status >= 400 && typeof retryAfter === "string")
        ) {
          const delay =
            typeof retryAfter === "string"
              ? /^\d+$/.test(retryAfter)
                ? Number(retryAfter) * 1000
                : Date.parse(retryAfter) - Date.now()
              : 60_000;
          if (Number.isFinite(delay) && delay > 0)
            this.retryDeadlines.set(
              url.origin,
              Math.max(
                this.retryDeadlines.get(url.origin) ?? 0,
                Date.now() + delay,
              ),
            );
          throw new Error(
            `Website returned ${response.status}; retry-after: ${retryAfter ?? "60 seconds"}`,
          );
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.location;
          if (typeof location !== "string")
            throw new Error("Redirect has no location");
          url = this.validateURL(new URL(location, url).href);
          continue;
        }
        if (response.status === 403 || response.status === 406) break;
        if (
          response.status < 200 ||
          response.status >= 300 ||
          response.status === 202
        )
          throw new Error(
            `Website returned ${response.status}; retry-after: ${response.headers["retry-after"] ?? "not supplied"}`,
          );
        return { ...response, url: url.href, agent };
      }
    }
    throw new Error(
      "Website rejected Patch and both identifiable browser-style agents",
    );
  }
}

const requestPage: Transport = (url, address, agent, signal) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: address.address,
        family: address.family,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        signal,
        agent: false,
        headers: {
          Host: url.host,
          "User-Agent": agent,
          Accept: "text/html,text/plain,text/markdown;q=0.9",
          "Accept-Encoding": "gzip, br, deflate",
        },
      },
      (response) => {
        const encoding = response.headers["content-encoding"];
        const stream =
          encoding === "br"
            ? response.pipe(createBrotliDecompress())
            : encoding === "gzip" || encoding === "deflate"
              ? response.pipe(createUnzip())
              : response;
        const chunks: Buffer[] = [];
        let bytes = 0;
        stream.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) {
            stream.destroy(new Error("Page exceeds 2 MB"));
            req.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        stream.on("error", reject);
        response.on("error", reject);
        stream.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
