import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import ipaddr from "ipaddr.js";

export const MAX_WEB_URL = 4_096;
export const MAX_WEB_BYTES = 2 * 1024 * 1024;

export class WebHttpError extends Error {
  constructor(readonly code: "blocked_address" | "body_too_large" | "unsupported_content_encoding", message: string) {
    super(message);
  }
}

export function webUrl(input: string, { keepFragment = false } = {}): URL {
  if (!URL.canParse(input)) throw new Error("Expected an absolute HTTP or HTTPS URL.");
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP or HTTPS URL without embedded credentials.");
  }
  if (!keepFragment) url.hash = "";
  if (url.href.length > MAX_WEB_URL) throw new Error("The URL is too long.");
  return url;
}

export function webSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

type Address = { address: string; family: number };
type Resolve = (hostname: string) => Promise<Address[]>;
const globalUnicast = ipaddr.IPv6.parse("2000::");

function isPublicAddress(address: string): boolean {
  const ip = ipaddr.process(address);
  // IPv6 global unicast is currently allocated from 2000::/3. Special-use
  // ranges within it are excluded by range(), as are IPv4 special-use ranges.
  return ip.range() === "unicast" &&
    (!(ip instanceof ipaddr.IPv6) || ip.match(globalUnicast, 3));
}

async function publicAddresses(hostname: string, resolve: Resolve, signal: AbortSignal): Promise<Address[]> {
  if (/^(?:.+\.)?localhost\.?$/i.test(hostname)) {
    throw new WebHttpError("blocked_address", "Only public IP addresses are allowed.");
  }
  signal.throwIfAborted();
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await new Promise<Address[]>((accept, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => resolve(hostname))
      .then(accept, reject).finally(() => signal.removeEventListener("abort", abort));
  });
  signal.throwIfAborted();
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new WebHttpError("blocked_address", "Only public IP addresses are allowed.");
  }
  return addresses;
}

export type WebRequestOptions = {
  signal: AbortSignal;
  body?: string;
  headers?: Record<string, string>;
};

export type WebRequest = (url: URL, options: WebRequestOptions) => Promise<IncomingMessage>;
type Transport = (
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => {
  on(event: "error", listener: (error: Error) => void): void;
  end(body?: string): void;
};

/** Direct connection with DNS pinned to the addresses checked for this request. */
export function createWebRequest(
  resolve: Resolve = (hostname) => lookup(hostname, { all: true }),
  requestHttp: Transport = httpRequest,
  requestHttps: Transport = httpsRequest,
): WebRequest {
  return async (url, { signal, body, headers }) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = await publicAddresses(hostname, resolve, signal);
    const tls = url.protocol === "https:";
    const request = tls ? requestHttps : requestHttp;
    return new Promise((accept, reject) => {
      const outgoing = request({
        protocol: url.protocol,
        hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: body === undefined ? "GET" : "POST",
        ...(tls ? { rejectUnauthorized: true } : {}),
        headers: {
          "user-agent": "Cooper",
          "accept-encoding": "gzip, deflate, br",
          ...headers,
          ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }),
        },
        // An isolated agent prevents reuse of a connection from another lookup.
        agent: false,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
        signal,
      }, accept);
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };
}

export const requestWeb = createWebRequest();

function bodyTooLarge(): WebHttpError {
  return new WebHttpError("body_too_large", "The web response exceeds 2 MiB.");
}

async function collectBody(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_WEB_BYTES) throw bodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

const decoders = new Map([
  ["br", createBrotliDecompress],
  ["deflate", createInflate],
  ["gzip", createGunzip],
]);

export async function readWebBody(response: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  if (Number(response.headers["content-length"]) > MAX_WEB_BYTES) {
    response.destroy();
    throw bodyTooLarge();
  }
  const encoding = response.headers["content-encoding"]?.trim().toLowerCase() ?? "identity";
  if (encoding === "identity") return pipeline(response, (stream: Readable) => collectBody(stream), { signal });
  const decode = decoders.get(encoding);
  if (!decode) {
    response.destroy();
    throw new WebHttpError("unsupported_content_encoding", "The server returned an unsupported HTTP content encoding.");
  }
  let size = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > MAX_WEB_BYTES) callback(bodyTooLarge());
      else callback(null, chunk);
    },
  });
  return pipeline(response, limit, decode(), (stream: Readable) => collectBody(stream), { signal });
}
