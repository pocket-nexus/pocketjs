// The computer's copies of 3DS development keys, shared by every tool that
// speaks the Pocket Runtime development wire (`bun run 3ds:dev`, Pocket Hub).
//
// A console holds one key, sdmc:/pocketjs/runtime/dev.key; whoever holds the
// same 32 bytes connects. The computer keeps each key once, named by the
// device id the console announces in discovery (FNV-1a64 of the key), in
//
//   $POCKETJS_3DS_KEYS, else ~/.pocketjs/3ds/keys/   (0700)
//     <device id, 16 lowercase hex digits>.key       (0600, 64 hex digits + "\n")
//
// Keys written before the shared directory existed live in a checkout's
// .pocket/3ds/devices/<host>-<port>.key; they are read, matched by the device
// id each one hashes to, and never written.

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { POCKET_RUNTIME_TOKEN_BYTES, pocketRuntimeDeviceId } from "../contracts/spec/pocket-runtime-wire.ts";
import { parsePocketRuntimeToken } from "./3ds-runtime-client.ts";

/** The shared key directory: `$POCKETJS_3DS_KEYS`, else `~/.pocketjs/3ds/keys`. */
export function sharedKeyDirectory(env: Record<string, string | undefined> = process.env): string {
  const configured = env.POCKETJS_3DS_KEYS?.trim();
  return resolve(configured ? configured : join(homedir(), ".pocketjs", "3ds", "keys"));
}

/** Where keys written before the shared directory live in a PocketJS checkout. */
export function legacyKeyDirectory(checkout: string): string {
  return join(checkout, ".pocket", "3ds", "devices");
}

/** A device id as file names and logs spell it: 16 lowercase hex digits. */
export function deviceIdText(deviceId: bigint): string {
  return deviceId.toString(16).padStart(16, "0");
}

/** The shared file of the device with this id. */
export function keyPath(deviceId: bigint, directory = sharedKeyDirectory()): string {
  return join(directory, `${deviceIdText(deviceId)}.key`);
}

/** A key file's 32 bytes; throws on anything else. */
export function readKey(path: string): Uint8Array {
  return parsePocketRuntimeToken(readFileSync(path, "utf8"));
}

/**
 * Stores `token` under its device id in `directory` and returns the path. The
 * file is written whole before it takes the name, so a reader finds the old
 * key or the new one.
 */
export function writeKey(token: Uint8Array, directory = sharedKeyDirectory()): string {
  if (token.length !== POCKET_RUNTIME_TOKEN_BYTES) {
    throw new Error(`a 3DS development key is ${POCKET_RUNTIME_TOKEN_BYTES} bytes`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = keyPath(pocketRuntimeDeviceId(token), directory);
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, `${Buffer.from(token).toString("hex")}\n`, { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, path);
  return path;
}

export interface StoredKey {
  readonly path: string;
  readonly token: Uint8Array;
  readonly deviceId: bigint;
}

/** Every readable key in `directories`, in order, each device once; corrupt files are skipped. */
export function listKeys(directories: readonly string[]): StoredKey[] {
  const seen = new Set<bigint>();
  const keys: StoredKey[] = [];
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".key")).sort()) {
      const path = join(directory, name);
      try {
        const token = readKey(path);
        const deviceId = pocketRuntimeDeviceId(token);
        if (seen.has(deviceId)) continue;
        seen.add(deviceId);
        keys.push({ path, token, deviceId });
      } catch {
        // A corrupt file is reported when it is named explicitly; a search skips it.
      }
    }
  }
  return keys;
}

/**
 * The key of the device with `deviceId`: the shared file by its name first,
 * then any file of `directories` that hashes to the id.
 */
export function findKey(deviceId: bigint, directories: readonly string[]): StoredKey | null {
  for (const directory of directories) {
    const path = keyPath(deviceId, directory);
    if (!existsSync(path)) continue;
    try {
      const token = readKey(path);
      if (pocketRuntimeDeviceId(token) === deviceId) return { path, token, deviceId };
    } catch {
      // Fall through to the search, which skips it as well.
    }
  }
  return listKeys(directories).find((key) => key.deviceId === deviceId) ?? null;
}
