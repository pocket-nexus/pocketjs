// APK signing with Web Crypto: JAR signing (v1) and APK Signature Scheme v2,
// RSA PKCS #1 v1.5 with SHA-256, the two schemes apksigner writes for a
// minSdkVersion of 18 to 23. Android 4.3 reads v1 only; Android 7 and later
// read v2 and refuse an APK whose v1 signature says v2 was stripped.
//
//   v1  META-INF/MANIFEST.MF  SHA-256 of every entry's uncompressed bytes
//       META-INF/CERT.SF      SHA-256 of the manifest and of each of its sections,
//                             `X-Android-APK-Signed: 2`
//       META-INF/CERT.RSA     PKCS #7 SignedData: the certificate and the
//                             signature of CERT.SF, no signed attributes
//   v2  an APK Signing Block before the central directory: SHA-256 over 1 MiB
//       chunks of the entries, the central directory and the end record, the
//       certificate, and the signature of that signed data
//
// The signature of RSA PKCS #1 v1.5 carries no time and no randomness: the
// same key and the same entries give the same bytes. The key is checked
// against the certificate by verifying the v2 signature with the
// certificate's public key before the APK is returned.

import { unzipEntry, writeZip, type ZipInput } from "./zip.ts";

/** The key and certificate an APK is signed with. */
export interface ApkSigner {
  /** An RSA private key: PKCS #8 DER bytes, or a CryptoKey imported for RSASSA-PKCS1-v1_5 with SHA-256 and usage "sign". */
  readonly privateKey: CryptoKey | Uint8Array;
  /** The X.509 certificate, DER. */
  readonly certificate: Uint8Array;
}

const RSA_PKCS1_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
/** APK Signature Scheme v2's id for RSASSA-PKCS1-v1_5 with SHA-256. */
const V2_RSA_PKCS1_SHA256 = 0x0103;
const V2_BLOCK_ID = 0x7109871a;
const V1_NAME = "CERT";
const encoder = new TextEncoder();

function fail(message: string): never {
  throw new Error(`apk signing: ${message}`);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(text);
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);
  return out;
}

/** A v2 length-prefixed value: u32 length, then the parts. */
function prefixed(...parts: readonly Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(u32(body.length), body);
}

// ------------------------------------------------------------------ DER

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

/** A DER value: tag, length, contents. */
export function der(tag: number, ...contents: readonly Uint8Array[]): Uint8Array {
  const body = concat(...contents);
  return concat(Uint8Array.of(tag), derLength(body.length), body);
}

export function derObjectId(dotted: string): Uint8Array {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [40 * first! + second!];
  for (const arc of rest) {
    const groups: number[] = [];
    let value = arc;
    do {
      groups.unshift(value & 0x7f);
      value = Math.floor(value / 128);
    } while (value > 0);
    groups.forEach((group, index) => bytes.push(index < groups.length - 1 ? group | 0x80 : group));
  }
  return der(0x06, Uint8Array.from(bytes));
}

export const DER_NULL = Uint8Array.of(0x05, 0x00);
const SEQUENCE = 0x30;
const SET = 0x31;
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_RSA = "1.2.840.113549.1.1.1";
const OID_PKCS7_DATA = "1.2.840.113549.1.7.1";
const OID_PKCS7_SIGNED = "1.2.840.113549.1.7.2";

interface DerNode {
  readonly tag: number;
  /** The whole value, tag and length included. */
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

/** The DER values laid end to end from `start` to `end`. */
export function derChildren(bytes: Uint8Array, start: number, end: number): DerNode[] {
  const out: DerNode[] = [];
  let at = start;
  while (at < end) {
    const tag = bytes[at]!;
    let length = bytes[at + 1]!;
    let header = 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      if (count === 0 || count > 4) fail("a certificate field has an indefinite or oversized length");
      length = 0;
      for (let index = 0; index < count; index++) length = length * 256 + bytes[at + 2 + index]!;
      header = 2 + count;
    }
    if (at + header + length > end) fail("a certificate field runs past its parent");
    out.push({ tag, start: at, body: at + header, end: at + header + length });
    at += header + length;
  }
  return out;
}

/** The fields of an X.509 certificate a signature names: serial, issuer and public key. */
export function certificateFields(certificate: Uint8Array): { serial: Uint8Array; issuer: Uint8Array; publicKey: Uint8Array } {
  const [outer] = derChildren(certificate, 0, certificate.length);
  if (!outer || outer.tag !== SEQUENCE || outer.end !== certificate.length) fail("the certificate is not one DER sequence");
  const [tbs] = derChildren(certificate, outer.body, outer.end);
  if (!tbs || tbs.tag !== SEQUENCE) fail("the certificate has no TBSCertificate");
  const fields = derChildren(certificate, tbs.body, tbs.end);
  const offset = fields[0]?.tag === 0xa0 ? 1 : 0; // [0] version
  const pick = (index: number) => {
    const field = fields[offset + index] ?? fail("the certificate lacks a TBSCertificate field");
    return certificate.subarray(field.start, field.end);
  };
  const publicKey = pick(5);
  const [algorithm] = derChildren(publicKey, derChildren(publicKey, 0, publicKey.length)[0]!.body, publicKey.length);
  const [oid] = derChildren(publicKey, algorithm!.body, algorithm!.end);
  const rsa = derObjectId(OID_RSA);
  if (!oid || publicKey.subarray(oid.start, oid.end).join() !== rsa.join()) fail("the certificate's key is not RSA");
  return { serial: pick(0), issuer: pick(2), publicKey };
}

// ------------------------------------------------------------------ keys

async function signingKey(privateKey: CryptoKey | Uint8Array): Promise<CryptoKey> {
  if (privateKey instanceof Uint8Array) {
    try {
      return await crypto.subtle.importKey("pkcs8", privateKey as Uint8Array<ArrayBuffer>, RSA_PKCS1_SHA256, false, ["sign"]);
    } catch {
      fail("the private key is not an RSA PKCS #8 key");
    }
  }
  const algorithm = privateKey.algorithm as RsaHashedKeyAlgorithm;
  if (privateKey.type !== "private" || algorithm.name !== "RSASSA-PKCS1-v1_5" || algorithm.hash?.name !== "SHA-256" || !privateKey.usages.includes("sign")) {
    fail("the private key is not an RSASSA-PKCS1-v1_5 SHA-256 signing key");
  }
  return privateKey;
}

async function sign(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign(RSA_PKCS1_SHA256, key, data as Uint8Array<ArrayBuffer>));
}

/** Whether `signature` over `data` verifies under the certificate's public key. */
export async function verifiesUnder(certificate: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("spki", certificateFields(certificate).publicKey as Uint8Array<ArrayBuffer>, RSA_PKCS1_SHA256, false, ["verify"]);
  return crypto.subtle.verify(RSA_PKCS1_SHA256, key, signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
}

// ------------------------------------------------------------------ v1

/** A manifest line: 70 bytes, continued on lines of a space and 69 bytes (apksigner's widths). */
function manifestLine(text: string): string {
  if (!/^[\x20-\x7e]*$/.test(text)) fail(`${JSON.stringify(text)} is not printable ASCII`);
  let out = `${text.slice(0, 70)}\r\n`;
  for (let at = 70; at < text.length; at += 69) out += ` ${text.slice(at, at + 69)}\r\n`;
  return out;
}

async function v1Entries(files: ReadonlyArray<readonly [string, Uint8Array]>, key: CryptoKey, certificate: Uint8Array): Promise<ZipInput[]> {
  const sorted = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let manifest = "Manifest-Version: 1.0\r\nCreated-By: 1.0 (PocketJS repack)\r\n\r\n";
  let sections = "";
  for (const [name, bytes] of sorted) {
    const section = `${manifestLine(`Name: ${name}`)}SHA-256-Digest: ${base64(await sha256(bytes))}\r\n\r\n`;
    manifest += section;
    sections += `${manifestLine(`Name: ${name}`)}SHA-256-Digest: ${base64(await sha256(encoder.encode(section)))}\r\n\r\n`;
  }
  const manifestBytes = encoder.encode(manifest);
  const signatureFile = encoder.encode(
    "Signature-Version: 1.0\r\nCreated-By: 1.0 (PocketJS repack)\r\n" +
      `SHA-256-Digest-Manifest: ${base64(await sha256(manifestBytes))}\r\nX-Android-APK-Signed: 2\r\n\r\n${sections}`,
  );
  const signature = await sign(key, signatureFile);
  const { serial, issuer } = certificateFields(certificate);
  const sha256Algorithm = der(SEQUENCE, derObjectId(OID_SHA256), DER_NULL);
  const signerInfo = der(
    SEQUENCE,
    der(0x02, Uint8Array.of(1)),
    der(SEQUENCE, issuer, serial),
    sha256Algorithm,
    der(SEQUENCE, derObjectId(OID_RSA), DER_NULL),
    der(0x04, signature),
  );
  const signedData = der(
    SEQUENCE,
    der(0x02, Uint8Array.of(1)),
    der(SET, sha256Algorithm),
    der(SEQUENCE, derObjectId(OID_PKCS7_DATA)),
    der(0xa0, certificate),
    der(SET, signerInfo),
  );
  return [
    { name: "META-INF/MANIFEST.MF", data: manifestBytes },
    { name: `META-INF/${V1_NAME}.SF`, data: signatureFile },
    { name: `META-INF/${V1_NAME}.RSA`, data: der(SEQUENCE, derObjectId(OID_PKCS7_SIGNED), der(0xa0, signedData)) },
  ];
}

// ------------------------------------------------------------------ v2

/** The end-of-central-directory record's offset; the archive has no comment. */
function endOfCentralDirectory(apk: Uint8Array): number {
  const data = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  const at = apk.length - 22;
  if (at < 0 || data.getUint32(at, true) !== 0x06054b50) fail("the archive does not end with its end-of-central-directory record");
  return at;
}

/** v2's content digest: SHA-256 over 1 MiB chunks of each section, then over the chunk digests. */
async function contentDigest(sections: readonly Uint8Array[]): Promise<Uint8Array> {
  const digests: Uint8Array[] = [];
  for (const section of sections) {
    for (let at = 0; at < section.length; at += 1 << 20) {
      const chunk = section.subarray(at, Math.min(section.length, at + (1 << 20)));
      digests.push(await sha256(concat(Uint8Array.of(0xa5), u32(chunk.length), chunk)));
    }
  }
  return sha256(concat(Uint8Array.of(0x5a), u32(digests.length), ...digests));
}

async function v2Sign(apk: Uint8Array, key: CryptoKey, certificate: Uint8Array): Promise<Uint8Array> {
  const end = endOfCentralDirectory(apk);
  const centralDirectory = new DataView(apk.buffer, apk.byteOffset, apk.byteLength).getUint32(end + 16, true);
  const digest = await contentDigest([apk.subarray(0, centralDirectory), apk.subarray(centralDirectory, end), apk.subarray(end)]);
  const signedData = concat(
    prefixed(prefixed(u32(V2_RSA_PKCS1_SHA256), prefixed(digest))),
    prefixed(prefixed(certificate)),
    prefixed(),
  );
  const signature = await sign(key, signedData);
  if (!(await verifiesUnder(certificate, signedData, signature))) fail("the private key is not the certificate's key");
  const signer = concat(
    prefixed(signedData),
    prefixed(prefixed(u32(V2_RSA_PKCS1_SHA256), prefixed(signature))),
    prefixed(certificateFields(certificate).publicKey),
  );
  const value = prefixed(prefixed(signer));
  const pair = concat(u64(4 + value.length), u32(V2_BLOCK_ID), value);
  const blockSize = pair.length + 8 + 16;
  const block = concat(u64(blockSize), pair, u64(blockSize), encoder.encode("APK Sig Block 42"));
  const tail = new Uint8Array(apk.subarray(end));
  new DataView(tail.buffer).setUint32(16, centralDirectory + block.length, true);
  return concat(apk.subarray(0, centralDirectory), block, apk.subarray(centralDirectory, end), tail);
}

// ------------------------------------------------------------------ APK

/**
 * The signed APK of `entries`, in their order, with the v1 files after them
 * and the v2 block before the central directory. Entries carry their own
 * alignment (`align` on stored entries, as zipalign places them); none may be
 * under META-INF/.
 */
export async function signApk(entries: readonly ZipInput[], signer: ApkSigner): Promise<Uint8Array> {
  const key = await signingKey(signer.privateKey);
  certificateFields(signer.certificate);
  const files: Array<readonly [string, Uint8Array]> = [];
  for (const input of entries) {
    if (input.name.startsWith("META-INF/")) fail(`${input.name} is a signature file; the entries go in unsigned`);
    if (input.name.endsWith("/")) continue;
    files.push([input.name, "entry" in input ? await unzipEntry(input.entry) : input.data]);
  }
  const withV1 = await writeZip([...entries, ...(await v1Entries(files, key, signer.certificate))]);
  return v2Sign(withV1, key, signer.certificate);
}
