// Pocket Companion's control API as this screen reads it
// (tools/companion/control.ts). No request reaches it yet: a UI realm has no
// network namespace, and the worker domain that will carry these calls is
// not on the Zero's program (programs/cardputer-zero). Every request answers
// NO_NETWORK, so the pages show the companion as unreachable.

import { batch, createSignal } from "solid-js";
import { after } from "@pocketjs/framework/clock";
import { toAscii } from "./text.ts";

type NetMethod = "GET" | "POST" | "DELETE";

const COMPANION = "http://companion";
const NO_NETWORK = "No network on this screen yet: the companion's state and commands arrive with the worker port.";
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

/** The control API call the worker port will make: `method url` with a JSON
 *  body, at most `timeoutMs`. Until then every call fails with NO_NETWORK. */
function request<T>(_url: string, _method: NetMethod = "GET", _body?: unknown, _timeoutMs = 8000): Promise<T> {
  return Promise.reject(new Error(NO_NETWORK));
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
      // No poll runs: nothing answers until the worker port lands.
      setDown(toAscii(NO_NETWORK));
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
