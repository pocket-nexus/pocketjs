import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fnv1a64 } from "../contracts/spec/pocket-package.ts";

export function atomicWrite(path: string, data: string | Uint8Array): void {
  const next = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(next, data);
  renameSync(next, path);
}

export function usbHash(bytes: Uint8Array): string { return fnv1a64(bytes).toString(16).padStart(16, "0"); }

export type VitaUsbOp = "status" | "push" | "reload" | "capture" | "menu" | "native" | "reset";
interface Command {
  version: number;
  session: string;
  id: string;
  op: VitaUsbOp;
  size?: number;
  hash?: string;
  build?: string;
  title_id?: string;
}

class RuntimeUnavailable extends Error {}

function readOptional<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    // A Vita rename can remove the destination before publishing its replacement.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

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
      throw new RuntimeUnavailable("USB runtime status is stale; check cable and vita:dev serve");
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

  private completion(command: Command): { ok: boolean; data?: Record<string, any>; error?: string } | undefined {
    const response = readOptional<Record<string, any>>(join(this.directory, `${command.id}.json`));
    if (response && (response.id !== command.id || response.session !== command.session)) throw new Error("response identity mismatch");
    if (response?.phase === "complete" && (command.op !== "native" || !response.ok)) {
      return { ok: response.ok === true, data: response.data, error: response.error };
    }
    if (command.op === "native") {
      try {
        const status = this.status();
        if (status.nativeBuild === command.build && status.frame > 1) {
          return status.error
            ? { ok: false, error: `replacement guest failed: ${status.error}` }
            : { ok: true, data: status };
        }
      } catch { /* A replacement process may not have published status yet. */ }
    }
    return undefined;
  }

  private retire(command: Command): void {
    const path = join(this.directory, "request.json");
    const current = readOptional<Command>(path);
    if (current?.id === command.id && current.session === command.session) rmSync(path, { force: true });
    rmSync(join(this.directory, `${command.id}.payload`), { force: true });
  }

  async command(op: VitaUsbOp, options: { payload?: Uint8Array; build?: string } = {}): Promise<Record<string, any>> {
    if (!["status", "push", "reload", "capture", "menu", "native", "reset"].includes(op)) throw new Error("unknown USB operation");
    if ((op === "push" || op === "native") !== (options.payload !== undefined)) throw new Error("only push/native commands require a payload");
    if (options.payload && (!options.payload.length || options.payload.length > (op === "native" ? 64 : 32) * 1024 * 1024)) {
      throw new Error("upload exceeds the Vita protocol size limit");
    }
    if (op === "native" && !/^[a-f0-9]{32}$/.test(options.build ?? "")) throw new Error("invalid native build identity");
    // Vita may remove the destination while replacing its status file. A slow
    // guest command also delays worker status until after its reply. Wait for
    // a fresh receipt before publishing, with a bounded offline preflight.
    const statusDeadline = Date.now() + Math.min(this.timeoutMs, 3000);
    let initial: Record<string, any>;
    for (;;) {
      try { initial = this.status(); break; }
      catch (error) {
        if (!(error instanceof RuntimeUnavailable) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (Date.now() >= statusDeadline) throw error;
        await Bun.sleep(25);
      }
    }
    const session = this.session();
    const id = randomBytes(16).toString("hex");
    const lock = join(this.directory, "command.lock");
    try { mkdirSync(lock); } catch { throw new Error("another Vita USB command owns this session"); }
    const payloadPath = join(this.directory, `${id}.payload`);
    const payload = options.payload;
    const request: Command = { version: 1, session, id, op,
      ...(payload ? { size: payload.length, hash: usbHash(payload) } : {}),
      ...(op === "native" ? { build: options.build, title_id: this.titleId } : {}),
    };
    let completed = false;
    let published = false;
    try {
      const previous = readOptional<Command>(join(this.directory, "request.json"));
      if (previous) {
        if (!/^[a-f0-9]{32}$/.test(previous.id)) throw new Error("invalid pending request identity");
        // Live status for a new session proves the worker has left any old
        // operation. In the same session, only its completion retires a request.
        if (previous.session === session && !this.completion(previous)) {
          throw new Error(`${previous.op}: request ${previous.id} is still pending; reconnect USB and wait for its receipt`);
        }
        this.retire(previous);
      }
      if (op === "native" && initial.nativeBuild === options.build) throw new Error("this native build is already running");
      if (payload) atomicWrite(payloadPath, payload);
      atomicWrite(join(this.directory, "request.json"), JSON.stringify(request));
      published = true;
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        if (this.session() !== session) throw new Error("USB session changed during command");
        const response = this.completion(request);
        if (response) {
          completed = true;
          if (!response.ok) throw new Error(response.error ?? "USB command failed");
          return { ...response.data, requestId: id };
        }
        await Bun.sleep(100);
      }
      throw new Error(`${op}: no completion receipt; the operation may still be pending on the device`);
    } finally {
      try {
        if (completed) {
          // A completed mailbox must not replay when the LiveArea bubble is
          // reopened. Retain the response as a receipt; retire consumed uploads.
          this.retire(request);
        }
        if (!published) rmSync(payloadPath, { force: true });
        // On timeout, retain the request and payload: the device may still be
        // reading them, so completion has not been established.
      } finally { rmSync(lock, { recursive: true, force: true }); }
    }
  }
}
