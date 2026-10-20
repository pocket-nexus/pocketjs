// The companion's model runtime: one `codex app-server` child speaking
// JSON-RPC over stdio (one JSON object per line), shared by every linked
// console. The child runs with its own CODEX_HOME under the companion store,
// so the user's global instructions, hooks, MCP servers, skills and plugins
// stay out of the console's turns; only the sign-in is shared, through a
// symlink to ~/.codex/auth.json.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export interface CodexHomeOptions {
  /** Model id; the user's ~/.codex/config.toml `model` when absent. */
  model?: string;
  /** model_reasoning_effort; "low" when absent. */
  effort?: string;
}

/** The user's codex home: $CODEX_HOME of this process, else ~/.codex. */
export function userCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

/** A top-level string key of a TOML file, read without a TOML parser. */
function tomlTopString(text: string, key: string): string | undefined {
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) return undefined; // tables begin: top level is over
    const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

/** Codex features that bring tools, hooks or startup work the console agent
 *  has no use for: the agent's only tools are the dynamic `pocket` ones. */
export const CODEX_FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "sleep_tool",
  "hooks",
  "multi_agent",
  "apps",
  "tool_suggest",
  "plugins",
  "browser_use",
  "computer_use",
  "image_generation",
  "skill_search",
  "goals",
  "memories",
  "in_app_browser",
  "realtime_conversation",
] as const;

/** Write `<store>/codex`: config.toml and a symlink to the user's auth.json.
 *  Returns the directory and the model it configured. */
export function prepareCodexHome(storeDir: string, options: CodexHomeOptions = {}): { home: string; model: string | undefined; signedIn: boolean } {
  const home = join(storeDir, "codex");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const user = userCodexHome();
  const auth = join(user, "auth.json");
  const link = join(home, "auth.json");
  const signedIn = existsSync(auth);
  let current: string | undefined;
  try {
    if (lstatSync(link).isSymbolicLink()) current = readlinkSync(link);
    else rmSync(link);
  } catch {}
  if (signedIn && current !== auth) {
    if (current !== undefined) rmSync(link);
    symlinkSync(auth, link);
  }
  let model = options.model;
  if (!model) {
    try {
      model = tomlTopString(readFileSync(join(user, "config.toml"), "utf8"), "model");
    } catch {}
  }
  const lines = [
    "# Written by Pocket Companion for the console agent; rewritten at every start.",
    ...(model ? [`model = ${JSON.stringify(model)}`] : []),
    `model_reasoning_effort = ${JSON.stringify(options.effort ?? "low")}`,
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    "project_doc_max_bytes = 0",
    'web_search = "disabled"',
    "",
    "[features]",
    // Every tool the agent does not use is one less schema in each request.
    ...CODEX_FEATURES_OFF.map((name) => `${name} = false`),
    "",
  ];
  writeFileSync(join(home, "config.toml"), lines.join("\n"), { mode: 0o600 });
  return { home, model, signedIn };
}

/** `$CODEX_BIN`, else the first `codex` on PATH, else the usual install
 *  places (an app started from Finder inherits no shell PATH): Homebrew,
 *  npm under nvm, and the CLI inside Codex.app. Directories of terminal
 *  wrappers (`.superset/bin`) are skipped: they re-launch the real binary
 *  with their own hooks. Null when there is none. */
export function findCodex(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CODEX_BIN) return env.CODEX_BIN;
  const home = homedir();
  const dirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir && !/\/\.superset[^/]*\/bin\/?$/.test(dir));
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", join(home, ".local", "bin"), join(home, ".bun", "bin"));
  try {
    const nvm = join(home, ".nvm", "versions", "node");
    for (const version of readdirSync(nvm).sort().reverse()) dirs.push(join(nvm, version, "bin"));
  } catch {}
  dirs.push("/Applications/Codex.app/Contents/Resources/codex-cli/bin");
  for (const dir of dirs) {
    const candidate = join(dir, "codex");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

export interface CodexNotification {
  method: string;
  params: Json;
}

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params: Json;
}

export interface CodexClientOptions {
  bin: string;
  /** CODEX_HOME for the child. */
  home: string;
  /** Extra arguments after `app-server` (tests). */
  args?: string[];
  log?: (line: string) => void;
  clientName?: string;
  version?: string;
}

/** One app-server child. Requests reject when the child exits; the next
 *  request starts a new child (and `onRestart` listeners hear about it, since
 *  every thread of the old child is gone). */
export class CodexClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<void> | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: Json) => void; reject: (error: Error) => void; method: string }>();
  private buffer = "";
  private notificationListeners = new Set<(message: CodexNotification) => void>();
  private requestHandler: ((request: CodexServerRequest) => Promise<Json>) | undefined;
  private exitListeners = new Set<(reason: string) => void>();
  private generation = 0;

  constructor(readonly options: CodexClientOptions) {}

  /** Increments every time a child starts; a thread id is valid only in the
   *  generation that created it. */
  get epoch(): number {
    return this.generation;
  }

  get running(): boolean {
    return this.child !== undefined && this.starting === undefined;
  }

  onNotification(listener: (message: CodexNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: (reason: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Answers server requests (item/tool/call, approvals). */
  handleRequests(handler: (request: CodexServerRequest) => Promise<Json>) {
    this.requestHandler = handler;
  }

  async ensure(): Promise<void> {
    if (this.child && !this.starting) return;
    if (!this.starting) this.starting = this.start().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async start(): Promise<void> {
    const started = Date.now();
    const child = spawn(this.options.bin, ["app-server", ...(this.options.args ?? [])], {
      // The binary's own directory leads PATH: an npm install is a script
      // whose `#!/usr/bin/env node` needs the node next to it.
      env: { ...process.env, PATH: [dirname(this.options.bin), process.env.PATH ?? ""].join(delimiter), CODEX_HOME: this.options.home, RUST_LOG: process.env.RUST_LOG ?? "error" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.generation += 1;
    this.buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) if (line.trim()) this.options.log?.(`codex: ${line.trim().slice(0, 300)}`);
    });
    child.on("error", (error) => this.exited(child, `codex failed to start: ${error.message}`));
    child.on("exit", (code, signal) => this.exited(child, `codex exited (${signal ?? code})`));
    child.stdin.on("error", () => {});
    await this.call("initialize", {
      clientInfo: { name: this.options.clientName ?? "pocket_companion", title: "Pocket Companion", version: this.options.version ?? "1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ jsonrpc: "2.0", method: "initialized" });
    this.options.log?.(`codex: app-server ready in ${Date.now() - started} ms (CODEX_HOME ${this.options.home})`);
  }

  private exited(child: ChildProcessWithoutNullStreams, reason: string) {
    if (this.child !== child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
    this.options.log?.(reason);
    for (const listener of this.exitListeners) listener(reason);
  }

  private write(message: Json) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private call(method: string, params: Json): Promise<Json> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("codex is not running"));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** One request; starts the child first when it is not running. */
  async request(method: string, params: Json): Promise<Json> {
    await this.ensure();
    return this.call(method, params);
  }

  private receive(chunk: string) {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        this.options.log?.(`codex: unparsable line ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Json) {
    const { id, method } = message;
    if (method === undefined && (typeof id === "number" || typeof id === "string")) {
      const pending = this.pending.get(id as number);
      if (!pending) return;
      this.pending.delete(id as number);
      const error = message.error as { code?: number; message?: string } | undefined;
      if (error) pending.reject(new CodexRpcError(error.code ?? -1, `${pending.method}: ${error.message ?? "error"}`));
      else pending.resolve((message.result ?? {}) as Json);
      return;
    }
    if (typeof method !== "string") return;
    const params = (message.params ?? {}) as Json;
    if (id !== undefined) {
      const request = { id: id as number | string, method, params };
      const handler = this.requestHandler;
      const answer = handler ? handler(request) : Promise.reject(new Error(`no handler for ${method}`));
      answer.then(
        (result) => this.write({ jsonrpc: "2.0", id, result }),
        (error: Error) => this.write({ jsonrpc: "2.0", id, error: { code: -32000, message: error.message } }),
      );
      return;
    }
    for (const listener of this.notificationListeners) listener({ method, params });
  }

  stop() {
    const child = this.child;
    if (!child) return;
    this.exited(child, "codex stopped");
    child.kill();
  }
}
