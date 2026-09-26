import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface NetworkOptions { allowPrivate?: boolean; signal?: AbortSignal }
function privateAddress(host: string): boolean {
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (host.includes(":")) return host === "::" || host === "::1" || /^(fc|fd|fe[89ab])/.test(host) || host.startsWith("::ffff:");
  const p = host.split(".").map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0]! >= 224 ||
    p[0] === 169 && p[1] === 254 || p[0] === 172 && p[1]! >= 16 && p[1]! <= 31 ||
    p[0] === 192 && p[1] === 168 || p[0] === 100 && p[1]! >= 64 && p[1]! <= 127;
}
export function httpUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error("Use an HTTP(S) URL without embedded credentials");
  url.hash = "";
  return url.href;
}
async function validate(url: string, options: NetworkOptions) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (options.allowPrivate) return;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw Error("Private source address: enable --allow-private-sources for your own server");
}
/** Each redirect is checked and streamed bytes have a hard ceiling. */
export async function fetchBytes(input: string, maxBytes: number, options: NetworkOptions = {}): Promise<Uint8Array> {
  let url = httpUrl(input);
  const signal = AbortSignal.any([options.signal ?? new AbortController().signal, AbortSignal.timeout(30000)]);
  for (let redirects = 0; redirects <= 5; redirects++) {
    await validate(url, options);
    const response = await fetch(url, { redirect: "manual", signal, headers: { "User-Agent": "PocketManga/0.2 (relay)" } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw Error("Redirect without a destination");
      url = httpUrl(location, url); continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw Error(`Source returned HTTP ${response.status}${response.status === 429 ? "; retry after the source rate limit resets" : ""}`); }
    if (Number(response.headers.get("content-length")) > maxBytes) { await response.body?.cancel(); throw Error("Source exceeds download size limit"); }
    const reader = response.body?.getReader();
    if (!reader) throw Error("Empty source response");
    const parts: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length;
        if (length > maxBytes) throw Error("Source exceeds download size limit");
        parts.push(next.value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length); let at = 0;
    for (const part of parts) { bytes.set(part, at); at += part.length; }
    return bytes;
  }
  throw Error("Too many source redirects");
}
export async function fetchJson(url: string, options: NetworkOptions = {}): Promise<any> {
  return JSON.parse(new TextDecoder().decode(await fetchBytes(url, 4 * 1024 * 1024, options)));
}
