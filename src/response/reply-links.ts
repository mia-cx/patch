import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const LINK_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 5;
const LINK_CONCURRENCY = 4;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const privateAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  privateAddresses.addSubnet(address, prefix, "ipv4");
const publicIpv6 = new BlockList();
publicIpv6.addSubnet("2000::", 3, "ipv6");
privateAddresses.addSubnet("2001:db8::", 32, "ipv6");
privateAddresses.addSubnet("2001::", 32, "ipv6"); // Teredo embeds IPv4 destinations.
privateAddresses.addSubnet("2002::", 16, "ipv6"); //6to4 can tunnel into private IPv4.

type BrokenLink = {
  url: string;
  reason: "HTTP 404" | "DNS name does not resolve";
};

/** Check outgoing HTTP(S) links; only confirmed absence asks the model to retry. */
export async function findBrokenReplyLinks(
  content: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const urls = [
    ...new Set(
      Array.from(content.matchAll(/https?:\/\/[^\s<>"`]+/gi), ([match]) =>
        trimLinkPunctuation(match),
      ),
    ),
  ];
  const broken: BrokenLink[] = [];
  for (let offset = 0; offset < urls.length; offset += LINK_CONCURRENCY) {
    const results = await Promise.all(
      urls
        .slice(offset, offset + LINK_CONCURRENCY)
        .map(async (url): Promise<BrokenLink | undefined> => {
          const reason = await checkLink(url, signal);
          return reason ? { url, reason } : undefined;
        }),
    );
    for (const result of results) if (result) broken.push(result);
  }
  return broken;
}

function trimLinkPunctuation(text: string) {
  let link = text.replace(/[.,!?;:' ]+$/, "");
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    while (
      link.endsWith(close) &&
      link.split(close).length > link.split(open).length
    ) {
      link = link.slice(0, -1);
    }
  }
  return link;
}

async function checkLink(
  original: string,
  parent: AbortSignal,
): Promise<BrokenLink["reason"] | undefined> {
  const signal = AbortSignal.any([
    parent,
    AbortSignal.timeout(LINK_TIMEOUT_MS),
  ]);
  try {
    let url = new URL(original);
    let method = "HEAD";
    for (let redirects = 0; redirects <= MAX_REDIRECTS; ) {
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        return;
      const result = await requestStatus(url, method, signal);
      if (REDIRECT_STATUSES.has(result.status) && result.location) {
        url = new URL(result.location, url);
        redirects += 1;
        continue;
      }
      // Some sites reject HEAD or incorrectly return404 for it. Confirm with GET.
      if (method === "HEAD" && [404, 405, 501].includes(result.status)) {
        method = "GET";
        continue;
      }
      return result.status === 404 ? "HTTP 404" : undefined;
    }
  } catch (error) {
    parent.throwIfAborted();
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOTFOUND" || error.code === "EAI_NONAME")
    ) {
      return "DNS name does not resolve";
    }
    // Auth, server, TLS and transient network failures cannot prove absence.
  }
}

async function requestStatus(url: URL, method: string, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family
    ? [{ address: hostname, family }]
    : await abortable(lookup(hostname, { all: true }), signal);
  const address = addresses[0];
  if (!address || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Link check cannot access a non-public address");
  }
  signal.throwIfAborted();
  return new Promise<{ status: number; location: string | undefined }>(
    (resolve, reject) => {
      const request = url.protocol === "https:" ? httpsRequest : httpRequest;
      const req = request(
        url,
        {
          method,
          signal,
          agent: false,
          family: address.family,
          // Pin the checked DNS answer, including every redirect, to prevent rebinding.
          lookup: (_name, _options, callback) =>
            callback(null, address.address, address.family),
          headers: method === "GET" ? { Range: "bytes=0-0" } : {},
        },
        (response) => {
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
          });
          response.destroy(); // Headers suffice; never download a generated media link.
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

function isPublicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !privateAddresses.check(address, "ipv4");
  return (
    family === 6 &&
    publicIpv6.check(address, "ipv6") &&
    !privateAddresses.check(address, "ipv6")
  );
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
