// Pocket Companion's control API as this screen reads it
// (tools/companion/control.ts). The worker (worker.ts) performs each call:
// the program's `http` node sends `http://companion/...` to the companion on
// this machine with its token (programs/cardputer-zero/src/http.rs);
// `http://zero/...` is the program.

import { batch, createSignal } from "solid-js";
import { after } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { worker } from "@pocketjs/framework/worker/channels";
import { toAscii } from "./text.ts";
import { Answer, HEADER_BYTES, encodeCall, text } from "./wire.ts";

type NetMethod = "GET" | "POST" | "DELETE";

const COMPANION = "http://companion";
const STATUS_SECONDS = 2;
const SERVICES_SECONDS = 5;

export interface Linked {
  id: string;
  name: string;
  model: string;
  target: string;
  address: string;
  since: number;
}
export interface Paired {
  id: string;
  name: string;
  model: string;
  lastAddress: string;
  lastSeen: number;
}
export interface App {
  id: string;
  title: string;
  version: string;
  bytes: number;
  summary?: string;
  services?: string[];
}
export interface Status {
  companion: { id: string; name: string; port: number; version: number; addresses: string[] };
  consoles: Linked[];
  paired: Paired[];
  apps: App[];
  appsDirs: string[];
  pairing: { open: boolean; uri?: string; expiresAt?: number };
}
export interface Install {
  state: string;
  message: string;
  received: number;
  total: number;
}
export interface Services {
  services: {
    x?: { signedIn: boolean; since?: number; signingIn: boolean; lastError?: string };
    discord?: {
      configured: boolean;
      bot?: string;
      servers?: string[];
      invite?: string;
      contentIntent?: boolean;
      error?: string;
    };
    youtube?: { ready: boolean; ytDlp?: string; ffmpeg?: string; managed: boolean; install: Install };
  };
  agent: { on: boolean; enabled: boolean; codex?: string | null; signedIn: boolean };
}

/** `request(url, method, body, timeoutMs)`: one call through the worker,
 *  answered with the JSON the server returned. Records go out and come back
 *  once per frame. */
function createRequests() {
  const calls = worker.channel("request");
  const answers = worker.channel("response");
  const pending = new Map<number, { status: number; body: Uint8Array[]; resolve(value: unknown): void; reject(error: Error): void }>();
  const unsent: Uint8Array[] = [];
  let next = 1;
  const send = () => {
    while (unsent.length && calls.publish(unsent[0]!)) unsent.shift();
  };
  const settle = (id: number, failure: string) => {
    const call = pending.get(id)!;
    pending.delete(id);
    if (failure) return call.reject(new Error(failure));
    const length = call.body.reduce((sum, block) => sum + block.length, 0);
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const block of call.body) {
      bytes.set(block, at);
      at += block.length;
    }
    const answer = text(bytes);
    let value: { error?: string } = {};
    try {
      value = answer ? JSON.parse(answer) : {};
    } catch {
      if (call.status < 300) return call.reject(new Error("Pocket Companion sent something that is not JSON."));
    }
    if (call.status >= 300) return call.reject(new Error(value.error ?? (answer || `HTTP ${call.status}`)));
    call.resolve(value);
  };
  onFrame(() => {
    send();
    for (const record of answers.observe()) {
      const id = record.u32(0);
      const call = pending.get(id);
      if (!call) continue;
      const kind = record.u8(4);
      if (kind === Answer.head) call.status = record.u16le(HEADER_BYTES);
      else if (kind === Answer.body) call.body.push(record.copy().subarray(HEADER_BYTES));
      else if (kind === Answer.end) settle(id, text(record.copy().subarray(HEADER_BYTES)));
    }
  });
  return <T>(url: string, method: NetMethod = "GET", body?: unknown, timeoutMs = 8000): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      unsent.push(encodeCall(id, {
        url,
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
        maxBytes: 256 * 1024,
      }));
      pending.set(id, { status: 0, body: [], resolve: resolve as (value: unknown) => void, reject });
      send();
    });
}

const message = (error: unknown) => toAscii(error instanceof Error ? error.message : String(error));

/** A poll that runs `work` again after the seconds it returns. A poll asked
 *  for while one is in flight runs once that one lands, so one loop runs. */
function poller(work: () => Promise<number>) {
  let timer: (() => void) | null = null;
  let running = false;
  let again = false;
  const poll = async (): Promise<void> => {
    timer?.();
    timer = null;
    if (running) {
      again = true;
      return;
    }
    running = true;
    let seconds = STATUS_SECONDS;
    try {
      seconds = await work();
    } finally {
      running = false;
    }
    if (again) {
      again = false;
      return poll();
    }
    timer = after(seconds, () => void poll());
  };
  return poll;
}

export type Companion = ReturnType<typeof createCompanion>;

/** The companion's state, polled while the screen runs, and the owner's
 *  commands. `status()` is null until the first answer and while the
 *  companion does not answer; `down()` then says why. */
export function createCompanion() {
  const request = createRequests();
  const [status, setStatus] = createSignal<Status | null>(null);
  const [services, setServices] = createSignal<Services | null>(null);
  const [down, setDown] = createSignal("");
  const [busy, setBusy] = createSignal("");
  /** The last command's answer: its output, or why it failed. */
  const [note, setNote] = createSignal<{ text: string; failed: boolean } | null>(null);
  let statusText = "";
  let servicesText = "";

  const pollStatus = poller(async () => {
    try {
      const next = await request<Status>(`${COMPANION}/status`);
      const text = JSON.stringify(next);
      batch(() => {
        if (text !== statusText) {
          statusText = text;
          setStatus(next);
        }
        setDown("");
      });
    } catch (error) {
      statusText = "";
      batch(() => {
        setStatus(null);
        setDown(message(error));
      });
    }
    return STATUS_SECONDS;
  });

  const pollServices = poller(async () => {
    try {
      const next = await request<Services>(`${COMPANION}/services`, "GET", undefined, 20000);
      const text = JSON.stringify(next);
      if (text !== servicesText) {
        servicesText = text;
        setServices(next);
      }
    } catch {
      // The status poll reports a companion that is down.
    }
    // A download in progress reports its bytes every status beat.
    const installing = services()?.services.youtube?.install.state === "installing";
    return installing ? STATUS_SECONDS : SERVICES_SECONDS;
  });

  /** Run one command; the answer lands in `note()` and both polls rerun. */
  const run = async (label: string, work: () => Promise<string | void>) => {
    if (busy()) return;
    batch(() => {
      setBusy(label);
      setNote(null);
    });
    try {
      const output = await work();
      setNote(output ? { text: toAscii(output), failed: false } : null);
    } catch (error) {
      setNote({ text: message(error), failed: true });
    } finally {
      setBusy("");
      void pollStatus();
      void pollServices();
    }
  };

  return {
    status,
    services,
    down,
    busy,
    note,
    clearNote: () => setNote(null),
    start() {
      void pollStatus();
      void pollServices();
    },
    openPairing: () => run("Opening a pairing code", () => request(`${COMPANION}/pair`, "POST").then(() => {})),
    closePairing: () => run("Closing the pairing code", () => request(`${COMPANION}/pair`, "DELETE").then(() => {})),
    forget: (id: string) => run("Forgetting the console", () => request(`${COMPANION}/consoles/${id}`, "DELETE").then(() => {})),
    /** A service command, as `bun tools/companion.ts service <name> <args>`. */
    service: (label: string, name: string, args: string[]) =>
      run(label, () =>
        request<{ output: string }>(`${COMPANION}/service`, "POST", { name, args }, 60000).then(answer => answer.output),
      ),
    restart: () =>
      run("Restarting Pocket Companion", async () => {
        await request("http://zero/restart", "POST", undefined, 30000);
        return "Pocket Companion restarted. Connected consoles reconnect by themselves.";
      }),
    quit: () => void request("http://zero/quit", "POST").catch(() => {}),
  };
}
