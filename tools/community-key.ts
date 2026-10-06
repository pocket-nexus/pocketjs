// bun tools/community-key.ts
//
// The Pocket Studio community key in the form the Android repack and a
// Worker secret take: the PKCS #12 keystore
// `~/.config/pocket-nexus/signing/pocket-studio-community.p12`
// (POCKET_STUDIO_COMMUNITY_KEY names another path) becomes two files beside
// it, mode 600:
//
//   pocket-studio-community.pkcs8.der   the RSA private key, PKCS #8 DER
//   pocket-studio-community.cert.der    the X.509 certificate, DER
//
// OpenSSL reads the keystore's password from the `.password` file beside it
// (`-passin file:`), so the password is on no command line and in no output;
// the key goes from OpenSSL's stdout to the file without being printed. The
// tool writes nothing unless the certificate's SHA-256 is
// POCKET_STUDIO_COMMUNITY_SIGNER and the key signs what the certificate
// verifies. It never reads the Pocket Nexus release key.
//
// tools/repack.ts reads the two files with readCommunitySigner(); a Worker
// takes their bytes from its secrets (base64) as the repack's `signer`.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { POCKET_STUDIO_COMMUNITY_SIGNER } from "./repack/android.ts";
import { verifiesUnder, type ApkSigner } from "./repack/shared/apk-sign.ts";
import { sha256Hex } from "./repack/shared/runtime.ts";

export interface CommunityKeyPaths {
  readonly keystore: string;
  readonly password: string;
  readonly privateKey: string;
  readonly certificate: string;
}

/** The keystore, its password file and the two DER files, from POCKET_STUDIO_COMMUNITY_KEY or the default. */
export function communityKeyPaths(env: NodeJS.ProcessEnv = process.env): CommunityKeyPaths {
  const keystore = env.POCKET_STUDIO_COMMUNITY_KEY || join(env.HOME ?? homedir(), ".config/pocket-nexus/signing/pocket-studio-community.p12");
  if (!keystore.endsWith(".p12")) throw new Error(`community key: ${keystore} is not a .p12 keystore`);
  if (basename(keystore).includes("release")) throw new Error("community key: that is a release keystore; this tool converts the Pocket Studio community key only");
  const stem = keystore.slice(0, -".p12".length);
  return { keystore, password: `${stem}.password`, privateKey: `${stem}.pkcs8.der`, certificate: `${stem}.cert.der` };
}

/** The community key's two DER files as the Android repack's signer. */
export function readCommunitySigner(env: NodeJS.ProcessEnv = process.env): ApkSigner {
  const paths = communityKeyPaths(env);
  for (const file of [paths.privateKey, paths.certificate]) {
    if (!existsSync(file)) throw new Error(`community key: ${file} is absent; run \`bun tools/community-key.ts\``);
  }
  return { privateKey: new Uint8Array(readFileSync(paths.privateKey)), certificate: new Uint8Array(readFileSync(paths.certificate)) };
}

function openssl(): string {
  const homebrew = "/opt/homebrew/opt/openssl@3/bin/openssl";
  return existsSync(homebrew) ? homebrew : "openssl";
}

/** One PEM block's bytes from OpenSSL's output; the output itself is never printed. */
function pemBlock(output: Uint8Array, label: string): Uint8Array {
  const text = new TextDecoder().decode(output);
  const match = new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\s]+)-----END ${label}-----`).exec(text);
  if (!match) throw new Error(`community key: openssl printed no ${label} block`);
  const binary = atob(match[1]!.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** `openssl pkcs12` over the keystore with the password from its file; stdout comes back, stderr goes into the error. */
function pkcs12(paths: CommunityKeyPaths, args: readonly string[]): Uint8Array {
  const done = Bun.spawnSync([openssl(), "pkcs12", "-in", paths.keystore, "-passin", `file:${paths.password}`, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (done.exitCode !== 0) throw new Error(`community key: openssl pkcs12 exited ${done.exitCode}\n${done.stderr.toString().trim()}`);
  return new Uint8Array(done.stdout);
}

function writePrivate(path: string, bytes: Uint8Array): void {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, bytes, { mode: 0o600 });
  chmodSync(staging, 0o600);
  renameSync(staging, path);
  chmodSync(path, 0o600);
}

export async function convertCommunityKey(env: NodeJS.ProcessEnv = process.env): Promise<CommunityKeyPaths> {
  const paths = communityKeyPaths(env);
  for (const file of [paths.keystore, paths.password]) {
    if (!existsSync(file)) throw new Error(`community key: ${file} is absent`);
  }
  const keyOutput = pkcs12(paths, ["-nocerts", "-nodes"]);
  const privateKey = pemBlock(keyOutput, "PRIVATE KEY");
  keyOutput.fill(0);
  const certificate = pemBlock(pkcs12(paths, ["-nokeys", "-clcerts"]), "CERTIFICATE");

  const digest = await sha256Hex(certificate);
  if (digest !== POCKET_STUDIO_COMMUNITY_SIGNER) {
    privateKey.fill(0);
    throw new Error(`community key: the keystore's certificate is ${digest}, not the Pocket Studio community certificate; nothing written`);
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("pkcs8", privateKey as Uint8Array<ArrayBuffer>, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch {
    privateKey.fill(0);
    throw new Error("community key: the keystore's key is not an RSA PKCS #8 key; nothing written");
  }
  const probe = new TextEncoder().encode("pocket studio community key check");
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, probe));
  if (!(await verifiesUnder(certificate, probe, signature))) {
    privateKey.fill(0);
    throw new Error("community key: the keystore's key does not match its certificate; nothing written");
  }
  writePrivate(paths.privateKey, privateKey);
  writePrivate(paths.certificate, certificate);
  privateKey.fill(0);
  return paths;
}

if (import.meta.main) {
  try {
    const paths = await convertCommunityKey();
    console.log(`private key: ${paths.privateKey} (PKCS #8 DER, mode 600)`);
    console.log(`certificate: ${paths.certificate} (X.509 DER, mode 600)`);
    console.log(`certificate SHA-256: ${POCKET_STUDIO_COMMUNITY_SIGNER} (the Pocket Studio community certificate); the key signs what it verifies`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
