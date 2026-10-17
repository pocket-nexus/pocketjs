// tools/targets/store.ts — where installed toolchains live, and whether a
// target's toolchain is installed for this framework.
//
//   <cache>/store/<component digest>/receipt.json   a published component
//   <cache>/store/<component digest>/tree/          its files
//   <cache>/targets/<id>/<toolchain digest>.json     an install record
//   <cache>/locks/                                   install, record and store locks
//   <cache>/tmp/                                     staging; published by rename
//
// rustup components live in rustup's toolchain directory; the record names the
// toolchain. A build reads every path from the record of the toolchain digest
// the framework pins, and from nowhere else.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pocketNexusCacheRoot } from "./cache.ts";
import { uniqueSuffix } from "./lock.ts";
import {
  componentDigest,
  toolchainComponents,
  toolchainDigest,
  type Component,
  type ComponentRole,
} from "./toolchain.ts";
import { currentHost, type HostId, type TargetDescriptor } from "./types.ts";

const FRAMEWORK_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const RECORD_SCHEMA = "pocket-install/1";
export const RECEIPT_SCHEMA = "pocket-receipt/1";

export interface StoreLayout {
  readonly root: string;
  readonly store: string;
  readonly targets: string;
  readonly locks: string;
  readonly tmp: string;
}

export function storeLayout(env: NodeJS.ProcessEnv = process.env): StoreLayout {
  const root = pocketNexusCacheRoot(env);
  return {
    root,
    store: join(root, "store"),
    targets: join(root, "targets"),
    locks: join(root, "locks"),
    tmp: join(root, "tmp"),
  };
}

export type ComponentLocation = { readonly store: string } | { readonly rustup: string };

export interface RecordedComponent {
  readonly kind: Component["kind"];
  readonly role: ComponentRole;
  readonly digest: string;
  readonly location: ComponentLocation;
}

export interface InstallRecord {
  readonly schema: typeof RECORD_SCHEMA;
  readonly target: string;
  readonly digest: string;
  readonly host: HostId;
  readonly framework: { readonly name: string; readonly version: string; readonly root: string };
  readonly components: Readonly<Record<string, RecordedComponent>>;
  readonly installedAt: string;
}

export interface Receipt {
  readonly schema: typeof RECEIPT_SCHEMA;
  readonly digest: string;
  readonly pin: Record<string, unknown>;
  readonly verified: Record<string, unknown>;
  readonly installedAt: string;
}

export function frameworkIdentity(): InstallRecord["framework"] {
  const pkg = JSON.parse(readFileSync(join(FRAMEWORK_ROOT, "package.json"), "utf8"));
  return { name: pkg.name ?? "@pocketjs/framework", version: pkg.version ?? "0.0.0", root: FRAMEWORK_ROOT };
}

export const targetLock = (layout: StoreLayout, id: string) => join(layout.locks, `target-${id}.lock`);
export const storeLock = (layout: StoreLayout) => join(layout.locks, "store.lock");
export const componentLock = (layout: StoreLayout, digest: string) => join(layout.locks, `component-${digest}.lock`);
export const storeEntry = (layout: StoreLayout, digest: string) => join(layout.store, digest);
export const storeTree = (layout: StoreLayout, digest: string) => join(layout.store, digest, "tree");
export const recordPath = (layout: StoreLayout, id: string, digest: string) => join(layout.targets, id, `${digest}.json`);

export function readReceipt(layout: StoreLayout, digest: string): Receipt | null {
  try {
    const receipt = JSON.parse(readFileSync(join(storeEntry(layout, digest), "receipt.json"), "utf8")) as Receipt;
    return receipt.schema === RECEIPT_SCHEMA && receipt.digest === digest ? receipt : null;
  } catch {
    return null;
  }
}

/** Every install record of `id`, newest first. */
export function readRecords(layout: StoreLayout, id: string): InstallRecord[] {
  const directory = join(layout.targets, id);
  if (!existsSync(directory)) return [];
  const records: InstallRecord[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(readFileSync(join(directory, name), "utf8")) as InstallRecord;
      if (record.schema === RECORD_SCHEMA && record.target === id) records.push(record);
    } catch {
      // A record that does not parse names nothing; pruning ignores it.
    }
  }
  return records.sort((left, right) => right.installedAt.localeCompare(left.installedAt));
}

/** Every install record in the cache. */
export function readAllRecords(layout: StoreLayout): InstallRecord[] {
  if (!existsSync(layout.targets)) return [];
  return readdirSync(layout.targets).flatMap((id) => readRecords(layout, id));
}

/** Writes by rename, so a reader sees no record or the whole record. */
export function writeRecord(layout: StoreLayout, record: InstallRecord): void {
  const path = recordPath(layout, record.target, record.digest);
  const staging = `${path}.${uniqueSuffix()}.tmp`;
  mkdirSync(join(layout.targets, record.target), { recursive: true });
  writeFileSync(staging, JSON.stringify(record, null, 2) + "\n");
  renameSync(staging, path);
}

// ---------------------------------------------------------------------------
// rustup
// ---------------------------------------------------------------------------

/** rustup, from PATH or `$CARGO_HOME/bin`, or null. */
export function findRustup(env: NodeJS.ProcessEnv = process.env): string | null {
  const onPath = Bun.which("rustup", { PATH: env.PATH ?? "" });
  if (onPath) return onPath;
  const cargoHome = env.CARGO_HOME?.trim() || join(env.HOME || homedir(), ".cargo");
  const candidate = join(cargoHome, "bin", "rustup");
  return existsSync(candidate) ? candidate : null;
}

export interface RustupState {
  readonly components: ReadonlySet<string>;
  readonly targets: ReadonlySet<string>;
}

function rustupLines(rustup: string, args: string[], env: NodeJS.ProcessEnv): string[] | null {
  const result = Bun.spawnSync([rustup, ...args], { env: { ...env, RUSTUP_AUTO_INSTALL: "0" }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) return null;
  return result.stdout.toString().split("\n").map((line) => line.trim().split(/\s+/)[0]!).filter(Boolean);
}

/** The installed components and targets of `toolchain`, or null when rustup
 *  does not have the toolchain. */
export function rustupState(rustup: string, toolchain: string, env: NodeJS.ProcessEnv = process.env): RustupState | null {
  const toolchains = rustupLines(rustup, ["toolchain", "list"], env) ?? [];
  if (!toolchains.some((name) => name === toolchain || name.startsWith(`${toolchain}-`))) return null;
  const components = rustupLines(rustup, ["component", "list", "--installed", "--toolchain", toolchain], env);
  const targets = rustupLines(rustup, ["target", "list", "--installed", "--toolchain", toolchain], env);
  if (!components || !targets) return null;
  return { components: new Set(components), targets: new Set(targets) };
}

/** What a rustup component lacks: the toolchain, or components and targets. */
export function rustupMissing(component: { toolchain: string; components: readonly string[]; targets: readonly string[] }, state: RustupState | null): string[] {
  if (!state) return [`rustup toolchain ${component.toolchain}`];
  return [
    ...component.components.filter((name) => !state.components.has(name)).map((name) => `rustup component ${name} of ${component.toolchain}`),
    ...component.targets.filter((name) => !state.targets.has(name)).map((name) => `rustup target ${name} of ${component.toolchain}`),
  ];
}

// ---------------------------------------------------------------------------
// published components
// ---------------------------------------------------------------------------

/** Files a published component of this kind must hold, relative to its tree. */
export function expectedFiles(component: Component): string[] {
  switch (component.kind) {
    case "archive":
      return [...component.markers];
    case "file":
      return [component.file];
    case "cargo-install":
      return component.binaries.map((binary) => join("bin", binary));
    case "rustup":
      return [];
  }
}

/** What is missing from a published store component, or nothing. */
export function storeMissing(layout: StoreLayout, component: Component, digest: string): string[] {
  if (!readReceipt(layout, digest)) return [`${component.name} (${storeEntry(layout, digest)})`];
  const tree = storeTree(layout, digest);
  return expectedFiles(component)
    .filter((file) => !existsSync(join(tree, file)))
    .map((file) => `${component.name}: ${join(tree, file)}`);
}

// ---------------------------------------------------------------------------
// readiness
// ---------------------------------------------------------------------------

export type TargetState =
  | { readonly state: "installed"; readonly digest: string; readonly record: InstallRecord }
  | { readonly state: "not installed"; readonly digest: string }
  | { readonly state: "outdated"; readonly digest: string; readonly installed: InstallRecord }
  | { readonly state: "broken"; readonly digest: string; readonly record: InstallRecord; readonly missing: readonly string[] }
  | { readonly state: "unsupported"; readonly host: string; readonly hosts: readonly HostId[] }
  | { readonly state: "nothing to install"; readonly digest: string }
  | { readonly state: "no manifest" };

export interface StateOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: HostId | null;
  /** The rustup to ask; found on PATH when absent. */
  readonly rustup?: string | null;
}

/** The install state of a target on this host for this framework's pins. */
export function targetState(descriptor: TargetDescriptor, options: StateOptions = {}): TargetState {
  const env = options.env ?? process.env;
  const host = options.host === undefined ? currentHost() : options.host;
  if (!descriptor.toolchain) return { state: "no manifest" };
  if (!host || !descriptor.hosts.includes(host)) {
    return { state: "unsupported", host: host ?? `${process.platform}-${process.arch}`, hosts: descriptor.hosts };
  }
  const components = toolchainComponents(descriptor.toolchain, host);
  const digest = toolchainDigest(descriptor.toolchain, host);
  if (components.length === 0) return { state: "nothing to install", digest };
  const layout = storeLayout(env);
  const records = readRecords(layout, descriptor.id);
  const record = records.find((candidate) => candidate.digest === digest && candidate.host === host);
  if (!record) {
    const installed = records.find((candidate) => candidate.host === host);
    return installed ? { state: "outdated", digest, installed } : { state: "not installed", digest };
  }
  const rustup = options.rustup === undefined ? findRustup(env) : options.rustup;
  const missing: string[] = [];
  for (const component of components) {
    const recorded = record.components[component.name];
    const expected = componentDigest(component, host);
    if (!recorded || recorded.digest !== expected) {
      missing.push(`${component.name} (not in the record)`);
      continue;
    }
    if (component.kind === "rustup") {
      if (!rustup) missing.push(`rustup (needed for ${component.toolchain})`);
      else missing.push(...rustupMissing(component, rustupState(rustup, component.toolchain, env)));
    } else {
      missing.push(...storeMissing(layout, component, expected));
    }
  }
  return missing.length > 0 ? { state: "broken", digest, record, missing } : { state: "installed", digest, record };
}

export interface ResolvedComponent {
  readonly kind: Component["kind"];
  /** The component's tree in the store; absent for rustup components. */
  readonly path?: string;
  /** The rustup toolchain; for rustup components. */
  readonly toolchain?: string;
}

export interface ResolvedToolchain {
  readonly target: string;
  readonly digest: string;
  readonly rustup: string | null;
  readonly components: Readonly<Record<string, ResolvedComponent>>;
  /** The tree of a store component. */
  path(name: string): string;
  /** The toolchain of a rustup component. */
  toolchain(name: string): string;
}

export class ToolchainError extends Error {}

/** The diagnostic for a target that is not ready, naming the command that fixes it. */
export function stateMessage(descriptor: TargetDescriptor, state: TargetState): string | null {
  const framework = frameworkIdentity();
  const pinned = `${framework.name} ${framework.version}`;
  const add = `\n        run: pocket target add ${descriptor.id}`;
  switch (state.state) {
    case "installed":
    case "nothing to install":
    case "no manifest":
      return null;
    case "not installed":
      return `target ${descriptor.id} is not installed for ${pinned} (toolchain ${state.digest.slice(0, 8)})${add}`;
    case "outdated":
      return `target ${descriptor.id} is installed for toolchain ${state.installed.digest.slice(0, 8)} ` +
        `(${state.installed.framework.name} ${state.installed.framework.version}), and ${pinned} pins toolchain ${state.digest.slice(0, 8)}${add}`;
    case "broken":
      return `target ${descriptor.id} is installed (toolchain ${state.digest.slice(0, 8)}), and these components are gone:\n` +
        state.missing.map((item) => `          ${item}`).join("\n") + add;
    case "unsupported":
      return `target ${descriptor.id} does not install on ${state.host}; it installs on ${state.hosts.join(", ")}`;
  }
}

/**
 * The installed toolchain of a target, for a backend to read paths from.
 * Null for a target whose framework carries no toolchain manifest. Throws a
 * ToolchainError naming `pocket target add` when the target is not ready.
 */
export function requireToolchain(descriptor: TargetDescriptor, options: StateOptions = {}): ResolvedToolchain | null {
  const state = targetState(descriptor, options);
  if (state.state === "no manifest") return null;
  const message = stateMessage(descriptor, state);
  if (message) throw new ToolchainError(message);
  const env = options.env ?? process.env;
  const layout = storeLayout(env);
  const recorded = state.state === "installed" ? state.record.components : {};
  const components: Record<string, ResolvedComponent> = {};
  for (const [name, component] of Object.entries(recorded)) {
    components[name] = "store" in component.location
      ? { kind: component.kind, path: storeTree(layout, component.location.store) }
      : { kind: component.kind, toolchain: component.location.rustup };
  }
  const digest = state.state === "installed" || state.state === "nothing to install" ? state.digest : "";
  return {
    target: descriptor.id,
    digest,
    rustup: options.rustup === undefined ? findRustup(env) : options.rustup,
    components,
    path(name) {
      const path = components[name]?.path;
      if (!path) throw new ToolchainError(`target ${descriptor.id} has no store component ${name}`);
      return path;
    },
    toolchain(name) {
      const toolchain = components[name]?.toolchain;
      if (!toolchain) throw new ToolchainError(`target ${descriptor.id} has no rustup component ${name}`);
      return toolchain;
    },
  };
}
