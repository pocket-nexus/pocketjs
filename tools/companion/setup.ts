// Owner setup: what a service needs from its owner before it can do its work.
//
// Two kinds, declared by the service in a SetupSpec:
//
//   fields   values the owner types once: a key from a vendor's dashboard, an
//            instance URL. Kept in <store>/services/<name>/setup.json (0600);
//            `/_setup` answers whether each is set, never a secret's value.
//   tools    a vendor's own program the service runs, fetched for the owner
//            from the vendor when the owner consents to the vendor's terms,
//            and never bundled or passed on: SHA-256 checked when the spec
//            pins one, unpacked into <store>/tools/<id>/<digest>/, fetched
//            again after `refreshAfterDays` (a vendor's builds that expire),
//            the old build kept until the new one is in place.
//
// A service may also show a prompt: something the owner does elsewhere
// (confirm a code at a vendor's page, pick this device in a vendor's app).
//
// The companion answers every service's `/_setup` the same way (ServiceHost
// routes it to the provider's `setup`), so one setup page in an applet, or the
// Mac's menu, serves any service:
//
//   GET  /<service>/_setup                         SetupState
//   POST /<service>/_setup {field, value}          set a field (checked against its pattern)
//   POST /<service>/_setup {field, clear: true}    forget it
//   POST /<service>/_setup {tool, consent: true}   accept the vendor's terms and fetch the tool
//   POST /<service>/_setup {tool, update: true}    fetch it again now
//   POST /<service>/_setup {tool, remove: true}    delete it and withdraw the consent
//
// Each answers the SetupState after the change; a refused change answers 400
// with {error}.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { jsonResponse, readJson, ServiceError, type ServiceContext, type ServiceRequest } from "./services.ts";
import type { NetResponse } from "./fetch.ts";
import { writeSecret } from "./store.ts";

export type Platform = "linux-arm64" | "linux-x64" | "linux-arm" | "darwin-arm64" | "darwin-x64";

export interface SetupField {
  id: string;
  label: string;
  /** a key or a token: never answered, drawn as dots */
  secret: boolean;
  /** one line under the field */
  help?: string;
  /** where the owner gets the value */
  link?: { label: string; url: string };
  /** a regular expression the whole value matches */
  pattern?: string;
  maxLength?: number;
  optional?: boolean;
}

export interface VendorBuild {
  url: string;
  /** how it is packed: a tar.gz or zip archive, or the program itself */
  archive: "tar.gz" | "zip" | "file";
  /** the program inside the archive, a relative path */
  binary: string;
  /** when the vendor's build is pinned */
  sha256?: string;
}

export interface VendorTool {
  id: string;
  title: string;
  vendor: string;
  /** the vendor's terms the owner accepts by fetching it */
  terms: string;
  /** one line on what it is and why the service needs it */
  note?: string;
  builds: Partial<Record<Platform, VendorBuild>>;
  /** fetch it again once it is this many days old (a vendor's builds that expire) */
  refreshAfterDays?: number;
}

export interface SetupSpec {
  title: string;
  fields?: SetupField[];
  tools?: VendorTool[];
}

export interface SetupPrompt {
  /** code: show `code` (and `url`) for the owner to confirm at a vendor's page;
   *  pick: pick this device in a vendor's app; wait: something is on its way */
  kind: "code" | "pick" | "wait";
  title: string;
  detail?: string;
  code?: string;
  url?: string;
  expiresAt?: number;
}

export type ToolState = "unavailable" | "absent" | "fetching" | "ready" | "failed";

export interface SetupState {
  service: string;
  title: string;
  fields: (Omit<SetupField, "pattern"> & { pattern?: string; set: boolean; value?: string })[];
  tools: {
    id: string;
    title: string;
    vendor: string;
    terms: string;
    note?: string;
    state: ToolState;
    consented: boolean;
    received: number;
    total: number;
    fetchedAt: number | null;
    message: string;
  }[];
  prompt: SetupPrompt | null;
  /** every field that is not optional is set, and every tool is ready */
  ready: boolean;
}

interface Kept {
  values: Record<string, string>;
  consent: Record<string, { at: number; terms: string }>;
}

interface Fetched {
  digest: string;
  fetchedAt: number;
  binary: string;
}

/** This computer, as a vendor names its builds. */
export function currentPlatform(platform = process.platform, arch = process.arch): Platform | null {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : arch === "arm" ? "arm" : null;
  if (!cpu) return null;
  if (platform === "linux") return `linux-${cpu}` as Platform;
  if (platform === "darwin" && cpu !== "arm") return `darwin-${cpu}` as Platform;
  return null;
}

export interface OwnerSetupOptions {
  platform?: Platform | null;
  now?: () => number;
  /** called after any change, for the service to start or stop what depends on it */
  onChange?: () => void;
}

export class OwnerSetup {
  private readonly file: string;
  private readonly toolsDir: string;
  private kept: Kept;
  private readonly progress = new Map<string, { state: ToolState; received: number; total: number; message: string }>();
  private readonly running = new Map<string, Promise<void>>();
  private current: SetupPrompt | null = null;
  private readonly platform: Platform | null;
  private readonly now: () => number;
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly context: ServiceContext, readonly service: string, readonly spec: SetupSpec, options: OwnerSetupOptions = {}) {
    this.file = join(context.storeDir, "services", service, "setup.json");
    this.toolsDir = join(context.storeDir, "tools");
    this.platform = options.platform === undefined ? currentPlatform() : options.platform;
    this.now = options.now ?? Date.now;
    if (options.onChange) this.listeners.push(options.onChange);
    this.kept = this.load();
  }

  private load(): Kept {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      return { values: raw.values && typeof raw.values === "object" ? raw.values : {}, consent: raw.consent && typeof raw.consent === "object" ? raw.consent : {} };
    } catch {
      return { values: {}, consent: {} };
    }
  }

  private save() {
    writeSecret(this.file, `${JSON.stringify(this.kept)}\n`);
  }

  private changed() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.context.log(`setup ${this.service}: ${(error as Error).message}`);
      }
    }
  }

  onChange(listener: () => void) {
    this.listeners.push(listener);
  }

  private field(id: string): SetupField {
    const field = this.spec.fields?.find((f) => f.id === id);
    if (!field) throw new ServiceError(400, { error: `${this.service} has no setup field ${id}` });
    return field;
  }

  private tool(id: string): VendorTool {
    const tool = this.spec.tools?.find((t) => t.id === id);
    if (!tool) throw new ServiceError(400, { error: `${this.service} has no setup tool ${id}` });
    return tool;
  }

  /** A field's value, or null while it is not set. */
  value(id: string): string | null {
    const value = this.kept.values[id];
    return typeof value === "string" && value !== "" ? value : null;
  }

  set(id: string, raw: string) {
    const field = this.field(id);
    const value = raw.trim();
    if (!value) throw new ServiceError(400, { error: `${field.label} is empty.` });
    if (value.length > (field.maxLength ?? 4096)) throw new ServiceError(400, { error: `${field.label} is too long.` });
    if (field.pattern && !new RegExp(`^(?:${field.pattern})$`).test(value)) throw new ServiceError(400, { error: `That is not a ${field.label}.` });
    this.kept.values[id] = value;
    this.save();
    this.changed();
  }

  clear(id: string) {
    this.field(id);
    delete this.kept.values[id];
    this.save();
    this.changed();
  }

  /** The prompt the owner sees, or null to take it down. */
  prompt(prompt: SetupPrompt | null) {
    this.current = prompt;
  }

  private build(tool: VendorTool): VendorBuild | null {
    return this.platform ? (tool.builds[this.platform] ?? null) : null;
  }

  private fetched(id: string): Fetched | null {
    try {
      const raw = JSON.parse(readFileSync(join(this.toolsDir, id, "current.json"), "utf8"));
      return typeof raw.digest === "string" && typeof raw.binary === "string" ? raw : null;
    } catch {
      return null;
    }
  }

  /** The tool's program when it is fetched and consented to, else null. An old
   *  build starts its fetch again in the background and is answered meanwhile. */
  toolPath(id: string): string | null {
    const tool = this.tool(id);
    if (!this.kept.consent[id]) return null;
    const fetched = this.fetched(id);
    if (!fetched) return null;
    const path = join(this.toolsDir, id, fetched.digest, fetched.binary);
    if (!existsSync(path)) return null;
    if (tool.refreshAfterDays && this.now() - fetched.fetchedAt > tool.refreshAfterDays * 86_400_000) void this.fetch(id).catch(() => {});
    return path;
  }

  /** Fetch the tool again now: the vendor answered that the build expired. */
  async refresh(id: string): Promise<void> {
    if (!this.kept.consent[id]) return;
    await this.fetch(id);
  }

  async consent(id: string): Promise<void> {
    const tool = this.tool(id);
    if (!this.build(tool)) throw new ServiceError(400, { error: `${tool.vendor} publishes no ${tool.title} build for this computer.` });
    this.kept.consent[id] = { at: this.now(), terms: tool.terms };
    this.save();
    this.changed();
    void this.fetch(id).catch(() => {});
  }

  remove(id: string) {
    this.tool(id);
    delete this.kept.consent[id];
    this.save();
    rmSync(join(this.toolsDir, id), { recursive: true, force: true });
    this.progress.delete(id);
    this.changed();
  }

  /** Fetch, check and unpack the tool; one fetch at a time per tool. */
  fetch(id: string): Promise<void> {
    const running = this.running.get(id);
    if (running) return running;
    const job = this.download(id).finally(() => this.running.delete(id));
    this.running.set(id, job);
    return job;
  }

  private async download(id: string): Promise<void> {
    const tool = this.tool(id);
    const build = this.build(tool);
    const report = (state: ToolState, message = "", received = 0, total = 0) => this.progress.set(id, { state, message, received, total });
    if (!build) {
      report("unavailable", `${tool.vendor} publishes no build for this computer.`);
      return;
    }
    const dir = join(this.toolsDir, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    report("fetching", `Fetching ${tool.title} from ${tool.vendor}`);
    try {
      const response = await fetch(build.url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`${tool.vendor} answered ${response.status}`);
      const total = Number(response.headers.get("content-length")) || 0;
      const hash = createHash("sha256");
      const chunks: Uint8Array[] = [];
      let received = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        hash.update(value);
        received += value.length;
        report("fetching", `Fetching ${tool.title} from ${tool.vendor}`, received, total);
      }
      const digest = hash.digest("hex");
      if (build.sha256 && build.sha256.toLowerCase() !== digest) throw new Error(`the ${tool.title} download does not match its SHA-256`);
      const into = join(dir, digest.slice(0, 16));
      const staging = `${into}.part`;
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      const archive = join(staging, build.archive === "file" ? build.binary : `download.${build.archive}`);
      writeFileSync(archive, Buffer.concat(chunks));
      if (build.archive !== "file") {
        const argv = build.archive === "tar.gz" ? ["tar", "-xzf", archive, "-C", staging] : ["unzip", "-oq", archive, "-d", staging];
        const unpack = Bun.spawnSync(argv, { stdout: "ignore", stderr: "pipe" });
        if (unpack.exitCode !== 0) throw new Error(`could not unpack ${tool.title}: ${new TextDecoder().decode(unpack.stderr).trim().slice(0, 200)}`);
        rmSync(archive, { force: true });
      }
      const binary = resolve(staging, build.binary);
      if (relative(staging, binary).startsWith("..") || !existsSync(binary) || !statSync(binary).isFile()) throw new Error(`${build.binary} is not in the ${tool.title} download`);
      chmodSync(binary, 0o755);
      rmSync(into, { recursive: true, force: true });
      renameSync(staging, into);
      const fetched: Fetched = { digest: digest.slice(0, 16), fetchedAt: this.now(), binary: build.binary };
      writeFileSync(join(dir, "current.json.tmp"), JSON.stringify(fetched));
      renameSync(join(dir, "current.json.tmp"), join(dir, "current.json"));
      // the builds before this one
      for (const name of readdirSync(dir)) if (name !== fetched.digest && name !== "current.json" && !name.endsWith(".part")) rmSync(join(dir, name), { recursive: true, force: true });
      report("ready", "", received, total);
      this.context.log(`setup ${this.service}: ${tool.title} fetched (${(received / 1048576).toFixed(1)} MiB)`);
      this.changed();
    } catch (error) {
      const message = (error as Error).message;
      report("failed", message);
      this.context.log(`setup ${this.service}: ${tool.title}: ${message}`);
      throw error;
    }
  }

  private toolState(tool: VendorTool): SetupState["tools"][number] {
    const progress = this.progress.get(tool.id);
    const fetched = this.fetched(tool.id);
    const consented = !!this.kept.consent[tool.id];
    let state: ToolState = !this.build(tool) ? "unavailable" : progress?.state === "fetching" ? "fetching" : consented && fetched ? "ready" : progress?.state === "failed" ? "failed" : "absent";
    if (state === "ready" && !this.toolPath(tool.id)) state = "absent";
    return {
      id: tool.id,
      title: tool.title,
      vendor: tool.vendor,
      terms: tool.terms,
      note: tool.note,
      state,
      consented,
      received: progress?.received ?? 0,
      total: progress?.total ?? 0,
      fetchedAt: fetched?.fetchedAt ?? null,
      message: progress?.message ?? "",
    };
  }

  state(): SetupState {
    const fields = (this.spec.fields ?? []).map((f) => ({ ...f, set: this.value(f.id) !== null, ...(f.secret ? {} : { value: this.value(f.id) ?? "" }) }));
    const tools = (this.spec.tools ?? []).map((t) => this.toolState(t));
    return {
      service: this.service,
      title: this.spec.title,
      fields,
      tools,
      prompt: this.current,
      ready: fields.every((f) => f.optional || f.set) && tools.every((t) => t.state === "ready"),
    };
  }

  /** `/_setup`, for ServiceHost. */
  async handle(request: ServiceRequest): Promise<Omit<NetResponse, "url">> {
    if (request.method === "GET") return jsonResponse(200, this.state());
    if (request.method !== "POST") return jsonResponse(405, { error: "_setup takes GET or POST" });
    const body = readJson<{ field?: unknown; value?: unknown; clear?: unknown; tool?: unknown; consent?: unknown; update?: unknown; remove?: unknown }>(request, { error: "_setup takes JSON {field, value} or {tool, consent}" });
    if (typeof body.field === "string") {
      if (body.clear === true) this.clear(body.field);
      else if (typeof body.value === "string") this.set(body.field, body.value);
      else throw new ServiceError(400, { error: "a field takes {field, value} or {field, clear: true}" });
    } else if (typeof body.tool === "string") {
      if (body.consent === true) await this.consent(body.tool);
      else if (body.update === true) {
        this.tool(body.tool);
        void this.fetch(body.tool).catch(() => {});
      } else if (body.remove === true) this.remove(body.tool);
      else throw new ServiceError(400, { error: "a tool takes {tool, consent: true}, {tool, update: true} or {tool, remove: true}" });
    } else throw new ServiceError(400, { error: "_setup takes {field, …} or {tool, …}" });
    return jsonResponse(200, this.state());
  }
}
