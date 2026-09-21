import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fnv1a64 } from "../contracts/spec/pocket-package.ts";

export function atomicWrite(path: string, data: string | Uint8Array): void {
  const next = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(next, data);
  renameSync(next, path);
}

export function usbHash(bytes: Uint8Array): string { return fnv1a64(bytes).toString(16).padStart(16, "0"); }

export class VitaUsbClient {
  readonly directory: string;
  constructor(readonly root: string, readonly titleId: string, readonly timeoutMs = 30_000) {
    if (!/^[A-Z0-9]{9}$/.test(titleId)) throw new Error("invalid Vita title id");
    this.directory = join(root, "pocket-vita", titleId);
  }

  session(): string {
    const value = JSON.parse(readFileSync(join(this.directory, "session.json"), "utf8"));
    if (value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.session)) throw new Error("invalid USB session");
    return value.session;
  }

  startSession(): string {
    mkdirSync(this.directory, { recursive: true });
    const session = randomBytes(16).toString("hex");
    atomicWrite(join(this.directory, "session.json"), JSON.stringify({ version: 1, session }));
    return session;
  }

  status(): Record<string, any> {
    const path = join(this.directory, "status.json");
    const status = JSON.parse(readFileSync(path, "utf8"));
    if (Date.now() - statSync(path).mtimeMs > 3000 || status.session !== this.session() || status.titleId !== this.titleId) {
      throw new Error("USB runtime status is stale; check cable and vita:dev serve");
    }
    return status;
  }

  async waitFor(predicate: (status: Record<string, any>) => boolean): Promise<Record<string, any>> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      try { const status = this.status(); if (predicate(status)) return status; } catch {}
      await Bun.sleep(100);
    }
    throw new Error("Vita USB timed out waiting for a live runtime receipt");
  }

  async command(op: string, options: { payload?: Uint8Array; build?: string } = {}): Promise<Record<string, any>> {
    if (options.payload && (!options.payload.length || options.payload.length > (op === "native" ? 64 : 32) * 1024 * 1024)) {
      throw new Error("upload exceeds the Vita protocol size limit");
    }
    // Vita may remove the destination while replacing its status file. Allow
    // that brief ENOENT window without publishing a command to an offline app.
    const statusDeadline = Date.now() + Math.min(this.timeoutMs, 3000);
    for (;;) {
      try { this.status(); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() >= statusDeadline) throw error;
        await Bun.sleep(25);
      }
    }
    const session = this.session();
    const id = randomBytes(16).toString("hex");
    const lock = join(this.directory, "command.lock");
    try { mkdirSync(lock); } catch { throw new Error("another Vita USB command owns this session"); }
    const payloadPath = join(this.directory, `${id}.payload`);
    let completed = false;
    try {
      const payload = options.payload;
      if (payload) atomicWrite(payloadPath, payload);
      atomicWrite(join(this.directory, "request.json"), JSON.stringify({ version: 1, session, id, op,
        ...(payload ? { size: payload.length, hash: usbHash(payload) } : {}),
        ...(options.build ? { build: options.build, title_id: this.titleId } : {}),
      }));
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        if (this.session() !== session) throw new Error("USB session changed during command");
        const path = join(this.directory, `${id}.json`);
        if (existsSync(path)) {
          const response = JSON.parse(readFileSync(path, "utf8"));
          if (response.id !== id || response.session !== session) throw new Error("response identity mismatch");
          if (response.phase === "complete") {
            completed = true;
            if (!response.ok) throw new Error(response.error);
            return { ...response.data, requestId: id };
          }
        }
        if (op === "native") {
          try {
            const status = this.status();
            if (status.nativeBuild === options.build && status.frame > 1 && !status.error) {
              completed = true;
              return { ...status, requestId: id };
            }
          } catch {}
        }
        await Bun.sleep(100);
      }
      throw new Error(`${op}: no completion receipt; the operation may still be pending on the device`);
    } finally {
      try {
        if (completed) {
          // A completed mailbox must not replay when the LiveArea bubble is
          // reopened. Retain the response as a receipt; retire consumed uploads.
          const path = join(this.directory, "request.json");
          let current: { id?: string; session?: string } = {};
          try { current = JSON.parse(readFileSync(path, "utf8")); } catch {}
          if (current.id === id && current.session === session) rmSync(path, { force: true });
          rmSync(payloadPath, { force: true });
        }
        // On timeout, retain the request and payload: the device may still be
        // reading them, so completion has not been established.
      } finally { rmSync(lock, { recursive: true, force: true }); }
    }
  }
}
