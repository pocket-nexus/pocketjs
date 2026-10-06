// Experiment: APK v1 (JAR) + v2 signing in TypeScript with WebCrypto only.
// signApk(unsignedAlignedApk, pkcs8Der, certDer) -> signed APK bytes.
import { readZip, writeZip, type ZipInput } from "../shared/zip.ts";

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
const u64 = (n: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const lp = (...parts: Uint8Array[]) => { const body = concat(...parts); return concat(u32(body.length), body); };

// --- DER -------------------------------------------------------------------
function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  while (n) { bytes.unshift(n & 0xff); n >>>= 8; }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
const tlv = (tag: number, ...content: Uint8Array[]) => { const body = concat(...content); return concat(Uint8Array.of(tag), derLength(body.length), body); };
const SEQ = (...c: Uint8Array[]) => tlv(0x30, ...c);
const SET = (...c: Uint8Array[]) => tlv(0x31, ...c);
const INT = (n: number) => tlv(0x02, Uint8Array.of(n));
const NULL = Uint8Array.of(0x05, 0x00);
const OCTETS = (b: Uint8Array) => tlv(0x04, b);
function OID(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const groups: number[] = [];
    let v = n;
    do { groups.unshift(v & 0x7f); v >>>= 7; } while (v);
    groups.forEach((g, i) => out.push(i < groups.length - 1 ? g | 0x80 : g));
  }
  return tlv(0x06, Uint8Array.from(out));
}
/** Child TLVs of a constructed DER value: [tag, start, end-of-header, end]. */
function children(der: Uint8Array, start: number, end: number): Array<{ tag: number; start: number; body: number; end: number }> {
  const out = [];
  let at = start;
  while (at < end) {
    const tag = der[at];
    let len = der[at + 1], header = 2;
    if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len << 8) | der[at + 2 + i]; header = 2 + n; }
    out.push({ tag, start: at, body: at + header, end: at + header + len });
    at += header + len;
  }
  return out;
}
function certificateParts(cert: Uint8Array) {
  const [certificate] = children(cert, 0, cert.length);
  const [tbs] = children(cert, certificate.body, certificate.end);
  const fields = children(cert, tbs.body, tbs.end);
  const offset = fields[0].tag === 0xa0 ? 1 : 0; // [0] version
  const pick = (i: number) => cert.subarray(fields[offset + i].start, fields[offset + i].end);
  return { serial: pick(0), issuer: pick(2), spki: pick(5) };
}

// --- v1 -------------------------------------------------------------------
function manifestLine(text: string): string {
  // 72-byte lines, continued by a leading space (entry names here are ASCII).
  let out = "", line = text;
  out += line.slice(0, 70) + "\r\n";
  line = line.slice(70);
  while (line.length) { out += " " + line.slice(0, 69) + "\r\n"; line = line.slice(69); }
  return out;
}

async function v1Entries(apk: Uint8Array, key: CryptoKey, cert: Uint8Array): Promise<ZipInput[]> {
  const entries = readZip(apk).filter((e) => !e.name.endsWith("/")).sort((a, b) => (a.name < b.name ? -1 : 1));
  const { unzipEntry } = await import("../shared/zip.ts");
  let mf = "Manifest-Version: 1.0\r\nCreated-By: pocketjs-ts-sign\r\n\r\n";
  let sf = "";
  for (const entry of entries) {
    const section = manifestLine(`Name: ${entry.name}`) + `SHA-256-Digest: ${b64(await sha256(await unzipEntry(entry)))}\r\n\r\n`;
    mf += section;
    sf += manifestLine(`Name: ${entry.name}`) + `SHA-256-Digest: ${b64(await sha256(enc.encode(section)))}\r\n\r\n`;
  }
  const mfBytes = enc.encode(mf);
  const sfBytes = enc.encode(
    `Signature-Version: 1.0\r\nCreated-By: pocketjs-ts-sign\r\nSHA-256-Digest-Manifest: ${b64(await sha256(mfBytes))}\r\nX-Android-APK-Signed: 2\r\n\r\n` + sf,
  );
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, sfBytes as Uint8Array<ArrayBuffer>));
  const { serial, issuer } = certificateParts(cert);
  const sha256Alg = SEQ(OID("2.16.840.1.101.3.4.2.1"), NULL);
  const signerInfo = SEQ(INT(1), SEQ(issuer, serial), sha256Alg, SEQ(OID("1.2.840.113549.1.1.1"), NULL), OCTETS(signature));
  const signedData = SEQ(INT(1), SET(sha256Alg), SEQ(OID("1.2.840.113549.1.7.1")), tlv(0xa0, cert), SET(signerInfo));
  const pkcs7 = SEQ(OID("1.2.840.113549.1.7.2"), tlv(0xa0, signedData));
  return [
    { name: "META-INF/MANIFEST.MF", data: mfBytes },
    { name: "META-INF/CERT.SF", data: sfBytes },
    { name: "META-INF/CERT.RSA", data: pkcs7 },
  ];
}

// --- v2 -------------------------------------------------------------------
async function chunkedDigest(sections: Uint8Array[]): Promise<Uint8Array> {
  const digests: Uint8Array[] = [];
  for (const section of sections) {
    for (let at = 0; at < section.length; at += 1 << 20) {
      const chunk = section.subarray(at, Math.min(section.length, at + (1 << 20)));
      digests.push(await sha256(concat(Uint8Array.of(0xa5), u32(chunk.length), chunk)));
    }
  }
  return sha256(concat(Uint8Array.of(0x5a), u32(digests.length), ...digests));
}

async function v2Sign(apk: Uint8Array, key: CryptoKey, cert: Uint8Array): Promise<Uint8Array> {
  const view = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  let eocd = apk.length - 22;
  while (view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  const cdOffset = view.getUint32(eocd + 16, true);
  const digest = await chunkedDigest([apk.subarray(0, cdOffset), apk.subarray(cdOffset, eocd), apk.subarray(eocd)]);
  const RSA_PKCS1_SHA256 = 0x0103;
  const signedData = concat(
    lp(lp(u32(RSA_PKCS1_SHA256), lp(digest))),
    lp(lp(cert)),
    lp(),
  );
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, signedData as Uint8Array<ArrayBuffer>));
  const signer = concat(lp(signedData), lp(lp(u32(RSA_PKCS1_SHA256), lp(signature))), lp(certificateParts(cert).spki));
  const value = lp(lp(signer));
  const pair = concat(u64(4 + value.length), u32(0x7109871a), value);
  const size = pair.length + 8 + 16;
  const block = concat(u64(size), pair, u64(size), enc.encode("APK Sig Block 42"));
  const tail = new Uint8Array(apk.subarray(eocd));
  new DataView(tail.buffer).setUint32(16, cdOffset + block.length, true);
  return concat(apk.subarray(0, cdOffset), block, apk.subarray(cdOffset, eocd), tail);
}

/** v1 + v2: the v1 files go into the archive (stored entries kept 4-aligned), then the v2 block wraps it. */
export async function signApk(unsigned: Uint8Array, pkcs8: Uint8Array, cert: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8 as Uint8Array<ArrayBuffer>, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const entries = readZip(unsigned).map((entry) => ({ name: entry.name, entry, align: 4 }));
  const withV1 = await writeZip([...entries, ...(await v1Entries(unsigned, key, cert))]);
  return v2Sign(withV1, key, cert);
}
