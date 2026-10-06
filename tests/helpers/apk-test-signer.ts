// A throwaway RSA key and a self-signed X.509 certificate for it, made with
// Web Crypto: what the Android repack tests sign with. Never the community
// key, never the release key.

import { concat, der, derObjectId, DER_NULL } from "../../tools/repack/shared/apk-sign.ts";

export interface TestSigner {
  readonly privateKey: Uint8Array;
  readonly cryptoKey: CryptoKey;
  readonly certificate: Uint8Array;
  readonly certificateSha256: string;
}

const SHA256_WITH_RSA = "1.2.840.113549.1.1.11";

function name(commonName: string): Uint8Array {
  return der(0x30, der(0x31, der(0x30, derObjectId("2.5.4.3"), der(0x0c, new TextEncoder().encode(commonName)))));
}

export async function makeTestSigner(commonName = "PocketJS Repack Test", modulusLength = 2048): Promise<TestSigner> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const algorithm = der(0x30, derObjectId(SHA256_WITH_RSA), DER_NULL);
  const time = (text: string) => der(0x17, new TextEncoder().encode(text));
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Uint8Array.of(2))),
    der(0x02, Uint8Array.of(0x01, 0x23, 0x45, 0x67)),
    algorithm,
    name(commonName),
    der(0x30, time("260101000000Z"), time("360101000000Z")),
    name(commonName),
    spki,
  );
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, tbs as Uint8Array<ArrayBuffer>));
  const certificate = der(0x30, tbs, algorithm, der(0x03, concat(Uint8Array.of(0), signature)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", certificate as Uint8Array<ArrayBuffer>));
  return {
    privateKey: new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    cryptoKey: pair.privateKey,
    certificate,
    certificateSha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

// ------------------------------------------------------------ verification

export interface ApkSignatureReport {
  /** The v2 signer's certificate, DER. */
  readonly v2Certificate: Uint8Array;
  /** The v1 PKCS #7 block's certificate, DER. */
  readonly v1Certificate: Uint8Array;
  /** Entry names MANIFEST.MF lists. */
  readonly v1Entries: readonly string[];
}

const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, index) => byte === b[index]);

async function rsaVerifies(spki: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("spki", spki as Uint8Array<ArrayBuffer>, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature as Uint8Array<ArrayBuffer>, data as Uint8Array<ArrayBuffer>);
}

/** Reads v2's length-prefixed values one after another. */
class Prefixed {
  private at: number;
  constructor(private readonly bytes: Uint8Array, start = 0, private readonly end = bytes.length) {
    this.at = start;
  }
  get done(): boolean {
    return this.at >= this.end;
  }
  u32(): number {
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset).getUint32(this.at, true);
    this.at += 4;
    return value;
  }
  next(): Uint8Array {
    const length = this.u32();
    if (this.at + length > this.end) throw new Error("v2: a length-prefixed value runs past its parent");
    const value = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return value;
  }
}

/**
 * Checks an APK's v1 and v2 signatures the way a verifier reads them, with
 * code apart from the signer's: v2's block, content digest and signature;
 * v1's entry digests, CERT.SF and the PKCS #7 signature over it. Throws on
 * the first failure.
 */
export async function verifyApkSignatures(apk: Uint8Array): Promise<ApkSignatureReport> {
  const { readZip, unzipEntry } = await import("../../tools/repack/shared/zip.ts");
  const { derChildren, certificateFields } = await import("../../tools/repack/shared/apk-sign.ts");
  const data = new DataView(apk.buffer, apk.byteOffset, apk.byteLength);
  const end = apk.length - 22;
  if (data.getUint32(end, true) !== 0x06054b50) throw new Error("no end-of-central-directory record at the end");
  const centralDirectory = data.getUint32(end + 16, true);
  if (new TextDecoder().decode(apk.subarray(centralDirectory - 16, centralDirectory)) !== "APK Sig Block 42") throw new Error("v2: no APK Signing Block");
  const blockSize = Number(data.getBigUint64(centralDirectory - 24, true));
  const blockStart = centralDirectory - blockSize - 8;
  if (Number(data.getBigUint64(blockStart, true)) !== blockSize) throw new Error("v2: the block's two sizes differ");
  let v2: Uint8Array | undefined;
  for (let at = blockStart + 8; at < centralDirectory - 24;) {
    const length = Number(data.getBigUint64(at, true));
    if (data.getUint32(at + 8, true) === 0x7109871a) v2 = apk.subarray(at + 12, at + 8 + length);
    at += 8 + length;
  }
  if (!v2) throw new Error("v2: no APK Signature Scheme v2 pair");
  const signers = new Prefixed(new Prefixed(v2).next());
  const signer = new Prefixed(signers.next());
  if (!signers.done) throw new Error("v2: more than one signer");
  const signedData = signer.next();
  const signatures = new Prefixed(signer.next());
  const publicKey = signer.next();
  const signature = new Prefixed(signatures.next());
  if (signature.u32() !== 0x0103) throw new Error("v2: the signature is not RSASSA-PKCS1-v1_5 SHA-256");
  if (!(await rsaVerifies(publicKey, signedData, signature.next()))) throw new Error("v2: the signature does not verify");
  const fields = new Prefixed(signedData);
  const digest = new Prefixed(new Prefixed(fields.next()).next());
  if (digest.u32() !== 0x0103) throw new Error("v2: the digest is not SHA-256");
  const expected = digest.next();
  const v2Certificate = new Prefixed(fields.next()).next();
  if (!equal(certificateFields(v2Certificate).publicKey, publicKey)) throw new Error("v2: the public key is not the certificate's");
  const tail = new Uint8Array(apk.subarray(end));
  new DataView(tail.buffer).setUint32(16, blockStart, true);
  const chunks: Uint8Array[] = [];
  for (const section of [apk.subarray(0, blockStart), apk.subarray(centralDirectory, end), tail]) {
    for (let at = 0; at < section.length; at += 1 << 20) {
      const chunk = section.subarray(at, Math.min(section.length, at + (1 << 20)));
      const prefix = new Uint8Array(5);
      prefix[0] = 0xa5;
      new DataView(prefix.buffer).setUint32(1, chunk.length, true);
      chunks.push(await sha256(concat(prefix, chunk)));
    }
  }
  const top = new Uint8Array(5 + chunks.length * 32);
  top[0] = 0x5a;
  new DataView(top.buffer).setUint32(1, chunks.length, true);
  chunks.forEach((chunk, index) => top.set(chunk, 5 + index * 32));
  if (!equal(await sha256(top), expected)) throw new Error("v2: the content digest does not match the APK");

  const entries = readZip(apk);
  const file = async (name: string) => unzipEntry(entries.find((entry) => entry.name === name) ?? (() => { throw new Error(`v1: no ${name}`); })());
  const manifest = await file("META-INF/MANIFEST.MF");
  const signatureFile = await file("META-INF/CERT.SF");
  const sections = (text: string) => text.split("\r\n\r\n").filter(Boolean).map((section) => {
    const lines = section.replace(/\r\n /g, "").split("\r\n");
    return { text: `${section}\r\n\r\n`, fields: new Map(lines.map((line) => [line.slice(0, line.indexOf(": ")), line.slice(line.indexOf(": ") + 2)])) };
  });
  const manifestSections = sections(new TextDecoder().decode(manifest));
  const digests = new Map(manifestSections.slice(1).map((section) => [section.fields.get("Name")!, section]));
  const signed = entries.filter((entry) => !entry.name.startsWith("META-INF/") && !entry.name.endsWith("/"));
  if (digests.size !== signed.length) throw new Error(`v1: MANIFEST.MF lists ${digests.size} entries, the APK holds ${signed.length}`);
  for (const entry of signed) {
    if (digests.get(entry.name)?.fields.get("SHA-256-Digest") !== base64(await sha256(await unzipEntry(entry)))) {
      throw new Error(`v1: ${entry.name} does not match its digest`);
    }
  }
  const signatureSections = sections(new TextDecoder().decode(signatureFile));
  const header = signatureSections[0]!.fields;
  if (header.get("SHA-256-Digest-Manifest") !== base64(await sha256(manifest))) throw new Error("v1: CERT.SF's manifest digest is wrong");
  if (header.get("X-Android-APK-Signed") !== "2") throw new Error("v1: CERT.SF does not say the APK is v2-signed");
  for (const section of signatureSections.slice(1)) {
    const name = section.fields.get("Name")!;
    if (section.fields.get("SHA-256-Digest") !== base64(await sha256(new TextEncoder().encode(digests.get(name)!.text)))) {
      throw new Error(`v1: CERT.SF's digest of ${name}'s section is wrong`);
    }
  }
  const block = await file("META-INF/CERT.RSA");
  const [contentInfo] = derChildren(block, 0, block.length);
  const [, explicit] = derChildren(block, contentInfo!.body, contentInfo!.end);
  const [signedDataNode] = derChildren(block, explicit!.body, explicit!.end);
  const parts = derChildren(block, signedDataNode!.body, signedDataNode!.end);
  const certificates = parts.find((part) => part.tag === 0xa0)!;
  const [certificateNode] = derChildren(block, certificates.body, certificates.end);
  const v1Certificate = block.subarray(certificateNode!.start, certificateNode!.end);
  const signerInfos = parts.at(-1)!;
  const [signerInfo] = derChildren(block, signerInfos.body, signerInfos.end);
  const encrypted = derChildren(block, signerInfo!.body, signerInfo!.end).at(-1)!;
  if (!(await rsaVerifies(certificateFields(v1Certificate).publicKey, signatureFile, block.subarray(encrypted.body, encrypted.end)))) {
    throw new Error("v1: the PKCS #7 signature over CERT.SF does not verify");
  }
  return { v2Certificate, v1Certificate, v1Entries: [...digests.keys()] };
}
