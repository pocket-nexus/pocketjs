// tools/targets/install.ts — `pocket target add` and `pocket target remove`.
//
// add installs every `toolchain` component of a target that has no published
// store entry, in manifest order, then writes the install record for the
// toolchain digest. Each component stages under <cache>/tmp and publishes by
// rename, so a failed or interrupted install leaves no store entry and no
// record. Downloads are checked against their SHA-256 before anything reads
// them; archive entries that leave the staging directory are rejected.
//
// Locks: a component lock per store entry while it installs; the target's
// record lock, exclusive for add and remove and shared by builds; the store
// lock, shared by add while it installs and until its record is written, and
// exclusive while remove prunes, so a prune never deletes a component an
// unfinished add published.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withArtifactLock, withExclusiveLock, withSharedLock, publishStagedDirectory, uniqueSuffix } from "./lock.ts";
import {
  componentLock,
  expectedFiles,
  findRustup,
  frameworkIdentity,
  readAllRecords,
  readRecords,
  RECEIPT_SCHEMA,
  RECORD_SCHEMA,
  recordPath,
  rustupMissing,
  rustupState,
  storeEntry,
  storeLayout,
  storeLock,
  storeMissing,
  targetLock,
  writeRecord,
  type ComponentLocation,
  type InstallRecord,
  type RecordedComponent,
  type StoreLayout,
} from "./store.ts";
import {
  componentDigest,
  componentPin,
  sourceFor,
  toolchainComponents,
  toolchainDigest,
  type ArchiveComponent,
  type CargoInstallComponent,
  type Component,
  type FileComponent,
  type RustupComponent,
  type Source,
} from "./toolchain.ts";
import { currentHost, type HostId, type TargetDescriptor } from "./types.ts";

export class InstallError extends Error {}

export interface InstallOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: HostId | null;
  /** The rustup to run; found on PATH when absent. */
  readonly rustup?: string | null;
  readonly log?: (line: string) => void;
}

const LONG_LOCK = { timeoutMs: 60 * 60_000, staleMs: 2 * 60 * 60_000 };

function run(command: string[], options: { env: NodeJS.ProcessEnv; cwd?: string; quiet?: boolean }): void {
  const result = Bun.spawnSync(command, {
    env: options.env,
    cwd: options.cwd,
    stdout: options.quiet ? "pipe" : "inherit",
    stderr: options.quiet ? "pipe" : "inherit",
  });
  if (result.exitCode !== 0) {
    const detail = options.quiet ? `\n${result.stderr?.toString().trim() ?? ""}` : "";
    throw new InstallError(`${command.slice(0, 3).join(" ")} … failed with exit ${result.exitCode}${detail}`);
  }
}

function output(command: string[], env: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync(command, { env, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new InstallError(`${command.slice(0, 2).join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

// ---------------------------------------------------------------------------
// downloads and archives
// ---------------------------------------------------------------------------

/** Downloads `source` to `destination` and checks its SHA-256. */
async function download(source: Source, destination: string, log: (line: string) => void): Promise<void> {
  const response = await fetch(source.url, { redirect: "follow" }).catch((error: unknown) => {
    throw new InstallError(`download failed: ${source.url} (${error instanceof Error ? error.message : String(error)})`);
  });
  if (!response.ok || !response.body) throw new InstallError(`download failed: ${source.url} (HTTP ${response.status})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  log(`    downloading ${source.url}${length ? ` (${(length / 1e6).toFixed(1)} MB)` : ""}`);
  const hash = createHash("sha256");
  const writer = Bun.file(destination).writer();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    writer.write(value);
  }
  await writer.end();
  const digest = hash.digest("hex");
  if (digest !== source.sha256) {
    throw new InstallError(`SHA-256 mismatch for ${source.url}: expected ${source.sha256}, got ${digest}`);
  }
}

/** Entry names that would land outside the extraction directory. */
export function unsafeEntries(names: readonly string[]): string[] {
  return names.filter((name) => isAbsolute(name) || name.split("/").includes(".."));
}

/** Symbolic links under `directory` whose target lies outside it. */
export function escapingLinks(directory: string): string[] {
  const escaping: string[] = [];
  // Walks with lstat: a link to a directory is checked, never entered.
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!stat.isSymbolicLink()) continue;
      const inside = relative(directory, resolve(dirname(path), readlinkSync(path)));
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        escaping.push(`${relative(directory, path)} -> ${readlinkSync(path)}`);
      }
    }
  }
  return escaping;
}

function extract(component: ArchiveComponent, archive: string, into: string, env: NodeJS.ProcessEnv): void {
  const tool = component.format === "zip" ? "unzip" : "tar";
  if (!Bun.which(tool, { PATH: env.PATH ?? "" })) {
    throw new InstallError(`${component.name} needs \`${tool}\` on PATH; install it with the system package manager`);
  }
  const names = component.format === "zip"
    ? output(["unzip", "-Z1", archive], env).split("\n").filter(Boolean)
    : output(["tar", "-tf", archive], env).split("\n").filter(Boolean);
  const unsafe = unsafeEntries(names);
  if (unsafe.length > 0) throw new InstallError(`${component.name}: archive entries leave the directory: ${unsafe.slice(0, 5).join(", ")}`);
  mkdirSync(into, { recursive: true });
  if (component.format === "zip") run(["unzip", "-q", archive, "-d", into], { env, quiet: true });
  else run(["tar", "-xf", archive, "-C", into], { env, quiet: true });
  const escaping = escapingLinks(into);
  if (escaping.length > 0) throw new InstallError(`${component.name}: archive links leave the directory: ${escaping.slice(0, 5).join(", ")}`);
}

// ---------------------------------------------------------------------------
// components
// ---------------------------------------------------------------------------

interface Context {
  readonly layout: StoreLayout;
  readonly env: NodeJS.ProcessEnv;
  readonly host: HostId;
  readonly rustup: string | null;
  readonly log: (line: string) => void;
}

function requireRustup(context: Context, component: Component): string {
  if (context.rustup) return context.rustup;
  throw new InstallError(`${component.name} needs rustup 1.28 or later; install it from https://rustup.rs and run the command again`);
}

function installRustup(context: Context, component: RustupComponent): ComponentLocation {
  const rustup = requireRustup(context, component);
  const env = { ...context.env, RUSTUP_AUTO_INSTALL: "0" };
  const before = rustupState(rustup, component.toolchain, env);
  const missing = rustupMissing(component, before);
  if (missing.length === 0) {
    context.log(`  · ${component.name}  ${component.toolchain} (installed)`);
    return { rustup: component.toolchain };
  }
  if (!before) {
    run([
      rustup, "toolchain", "install", component.toolchain, "--profile", "minimal",
      ...component.components.flatMap((name) => ["--component", name]),
      ...component.targets.flatMap((name) => ["--target", name]),
    ], { env });
  } else {
    const components = component.components.filter((name) => !before.components.has(name));
    const targets = component.targets.filter((name) => !before.targets.has(name));
    if (components.length > 0) run([rustup, "component", "add", "--toolchain", component.toolchain, ...components], { env });
    if (targets.length > 0) run([rustup, "target", "add", "--toolchain", component.toolchain, ...targets], { env });
  }
  const after = rustupMissing(component, rustupState(rustup, component.toolchain, env));
  if (after.length > 0) throw new InstallError(`${component.name}: rustup did not install ${after.join(", ")}`);
  context.log(`  ✓ ${component.name}  ${component.toolchain}${component.components.length ? ` + ${component.components.join(", ")}` : ""}`);
  return { rustup: component.toolchain };
}

function requireSource(context: Context, component: ArchiveComponent | FileComponent): Source {
  const source = sourceFor(component.source, context.host);
  if (!source) throw new InstallError(`${component.name} has no source for ${context.host}`);
  return source;
}

/** Builds the tree of a store component in `staging/tree`, returning what was verified. */
async function stage(context: Context, component: ArchiveComponent | FileComponent | CargoInstallComponent, staging: string): Promise<Record<string, unknown>> {
  const tree = join(staging, "tree");
  switch (component.kind) {
    case "file": {
      const source = requireSource(context, component);
      mkdirSync(tree, { recursive: true });
      await download(source, join(tree, component.file), context.log);
      return { sha256: source.sha256 };
    }
    case "archive": {
      const source = requireSource(context, component);
      const archive = join(staging, "download");
      await download(source, archive, context.log);
      const extracted = join(staging, "extracted");
      extract(component, archive, extracted, context.env);
      const root = component.root ? join(extracted, component.root) : extracted;
      if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new InstallError(`${component.name}: the archive has no directory ${component.root}`);
      renameSync(root, tree);
      rmSync(archive, { force: true });
      rmSync(extracted, { recursive: true, force: true });
      return { sha256: source.sha256 };
    }
    case "cargo-install": {
      const rustup = requireRustup(context, component);
      context.log(`    cargo install ${component.package} (${component.source.git} ${component.source.revision.slice(0, 12)})`);
      run([
        rustup, "run", component.toolchain, "cargo", "install", "--locked",
        "--git", component.source.git, "--rev", component.source.revision,
        "--root", tree, component.package,
      ], {
        env: {
          ...context.env,
          RUSTUP_AUTO_INSTALL: "0",
          CARGO_TARGET_DIR: join(staging, "target"),
          // The tree's bin on PATH: cargo stops suggesting a PATH edit nobody makes.
          PATH: [join(tree, "bin"), context.env.PATH].filter(Boolean).join(":"),
        },
      });
      rmSync(join(staging, "target"), { recursive: true, force: true });
      return { revision: component.source.revision, host: context.host };
    }
  }
}

async function installStored(context: Context, component: ArchiveComponent | FileComponent | CargoInstallComponent): Promise<ComponentLocation> {
  const digest = componentDigest(component, context.host);
  const present = () => storeMissing(context.layout, component, digest).length === 0;
  if (present()) {
    context.log(`  · ${component.name}  ${digest.slice(0, 12)} (installed)`);
    return { store: digest };
  }
  await withArtifactLock(componentLock(context.layout, digest), async () => {
    if (present()) return;
    const staging = join(context.layout.tmp, `${digest.slice(0, 12)}-${uniqueSuffix()}`);
    mkdirSync(staging, { recursive: true });
    try {
      const verified = await stage(context, component, staging);
      const missing = expectedFiles(component).filter((file) => !existsSync(join(staging, "tree", file)));
      if (missing.length > 0) throw new InstallError(`${component.name}: the installed tree lacks ${missing.join(", ")}`);
      await Bun.write(join(staging, "receipt.json"), JSON.stringify({
        schema: RECEIPT_SCHEMA,
        digest,
        pin: componentPin(component, context.host),
        verified: { ...verified, files: expectedFiles(component) },
        installedAt: new Date().toISOString(),
      }, null, 2) + "\n");
      publishStagedDirectory(staging, storeEntry(context.layout, digest));
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    context.log(`  ✓ ${component.name}  ${digest.slice(0, 12)}`);
  }, LONG_LOCK);
  return { store: digest };
}

function context(options: InstallOptions): Context {
  const env = options.env ?? process.env;
  const host = options.host === undefined ? currentHost() : options.host;
  if (!host) throw new InstallError(`pocket installs toolchains on macOS and Linux (arm64, x64); this host is ${process.platform}-${process.arch}`);
  return {
    layout: storeLayout(env),
    env,
    host,
    rustup: options.rustup === undefined ? findRustup(env) : options.rustup,
    log: options.log ?? ((line) => console.log(line)),
  };
}

/**
 * Installs the `toolchain` components of a target and writes its install
 * record. Returns the record; a second call installs nothing and fetches
 * nothing.
 */
export async function addTarget(descriptor: TargetDescriptor, options: InstallOptions = {}): Promise<InstallRecord> {
  const ctx = context(options);
  const manifest = descriptor.toolchain;
  if (!manifest) throw new InstallError(`${descriptor.id} has no toolchain manifest in this framework`);
  if (!descriptor.hosts.includes(ctx.host)) {
    throw new InstallError(`target ${descriptor.id} does not install on ${ctx.host}; it installs on ${descriptor.hosts.join(", ")}`);
  }
  const components = toolchainComponents(manifest, ctx.host);
  const digest = toolchainDigest(manifest, ctx.host);
  return await withExclusiveLock(targetLock(ctx.layout, descriptor.id), async () =>
    await withSharedLock(storeLock(ctx.layout), async () => {
      const recorded: Record<string, RecordedComponent> = {};
      for (const component of components) {
        const location = component.kind === "rustup"
          ? installRustup(ctx, component)
          : await installStored(ctx, component);
        recorded[component.name] = {
          kind: component.kind,
          role: component.role,
          digest: componentDigest(component, ctx.host),
          location,
        };
      }
      const record: InstallRecord = {
        schema: RECORD_SCHEMA,
        target: descriptor.id,
        digest,
        host: ctx.host,
        framework: frameworkIdentity(),
        components: recorded,
        installedAt: new Date().toISOString(),
      };
      writeRecord(ctx.layout, record);
      return record;
    }, LONG_LOCK), LONG_LOCK);
}

/**
 * Deletes every install record of a target, after the builds that hold one
 * finish, and prunes store entries no record names. rustup toolchains stay:
 * other projects use them.
 */
export async function removeTarget(id: string, options: InstallOptions = {}): Promise<{ records: number; pruned: string[] }> {
  const env = options.env ?? process.env;
  const layout = storeLayout(env);
  const records = await withExclusiveLock(targetLock(layout, id), async () => {
    const found = readRecords(layout, id);
    for (const record of found) rmSync(recordPath(layout, id, record.digest), { force: true });
    return found.length;
  }, LONG_LOCK);
  return { records, pruned: await prune(layout) };
}

/** Deletes store entries and staging directories no install record names. */
export async function prune(layout: StoreLayout): Promise<string[]> {
  return await withExclusiveLock(storeLock(layout), async () => {
    const referenced = new Set(
      readAllRecords(layout).flatMap((record) =>
        Object.values(record.components).flatMap((component) => "store" in component.location ? [component.location.store] : [])),
    );
    const pruned: string[] = [];
    if (existsSync(layout.store)) {
      for (const name of readdirSync(layout.store)) {
        if (referenced.has(name)) continue;
        rmSync(join(layout.store, name), { recursive: true, force: true });
        pruned.push(name);
      }
    }
    // Every add stages while it holds the store lock shared, so nothing stages now.
    rmSync(layout.tmp, { recursive: true, force: true });
    return pruned;
  }, LONG_LOCK);
}

