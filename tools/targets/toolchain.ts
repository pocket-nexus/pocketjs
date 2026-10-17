// tools/targets/toolchain.ts — toolchain manifests: the pinned components a
// target needs on the machine that builds it, and their digests.
//
// A component's digest is the SHA-256 of the canonical JSON of its pin, without
// its name, role and hosts, so equal pins in two targets share one store entry.
// Components that build host programs (cargo-install) add the host. A target's
// toolchain digest covers its `toolchain` components for one host; a pin change
// gives a new digest and a new install record.

import { createHash } from "node:crypto";
import { canonicalJson } from "../../framework/src/manifest/plan.ts";
import { HOST_IDS, type HostId } from "./types.ts";

export const TOOLCHAIN_SCHEMA = "pocket-toolchain/2";

export type ComponentRole = "toolchain" | "run" | "deploy";

export interface Source {
  readonly url: string;
  readonly sha256: string;
}

/** One source for every host, or one per host. */
export type HostSources = Source | Readonly<Partial<Record<HostId, Source>>>;

interface ComponentBase {
  readonly name: string;
  readonly role: ComponentRole;
  /** Hosts the component installs on; every host when absent. */
  readonly hosts?: readonly HostId[];
}

/** A rustup toolchain, by version or dated channel, with components and targets. */
export interface RustupComponent extends ComponentBase {
  readonly kind: "rustup";
  readonly toolchain: string;
  readonly components: readonly string[];
  readonly targets: readonly string[];
}

/** A verified zip or tarball; `root` is the directory inside the archive that
 *  becomes the component's tree, `markers` are files the tree must contain. */
export interface ArchiveComponent extends ComponentBase {
  readonly kind: "archive";
  readonly source: HostSources;
  readonly format: "zip" | "tar.gz" | "tar.xz";
  readonly root?: string;
  readonly markers: readonly string[];
}

/** One verified file, stored under `file`. */
export interface FileComponent extends ComponentBase {
  readonly kind: "file";
  readonly source: HostSources;
  readonly file: string;
}

/** `cargo install --locked` of a git revision, with a rustup toolchain the
 *  same manifest installs first. */
export interface CargoInstallComponent extends ComponentBase {
  readonly kind: "cargo-install";
  readonly source: { readonly git: string; readonly revision: string };
  readonly package: string;
  readonly binaries: readonly string[];
  readonly toolchain: string;
}

export type Component = RustupComponent | ArchiveComponent | FileComponent | CargoInstallComponent;

export interface ToolchainManifest {
  readonly schema: typeof TOOLCHAIN_SCHEMA;
  readonly target: string;
  readonly components: readonly Component[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_REVISION = /^[0-9a-f]{40}$/;
// A version (1.93.0) or a dated channel (nightly-2026-05-28); never `stable`.
const RUSTUP_PIN = /^(?:\d+\.\d+\.\d+|(?:nightly|beta)-\d{4}-\d{2}-\d{2})$/;
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function relativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.split("/").some((part) => part === ".." || part === "");
}

function sourceProblems(where: string, sources: HostSources): string[] {
  const entries: [string, Source][] = "url" in sources
    ? [["", sources as Source]]
    : Object.entries(sources as Record<string, Source>);
  if (entries.length === 0) return [`${where}: no source`];
  const problems: string[] = [];
  for (const [host, source] of entries) {
    const at = host ? `${where}.source.${host}` : `${where}.source`;
    if (host && !HOST_IDS.includes(host as HostId)) problems.push(`${at}: unknown host`);
    if (!/^https?:\/\//.test(source.url ?? "")) problems.push(`${at}.url: not an http(s) URL`);
    if (!SHA256.test(source.sha256 ?? "")) problems.push(`${at}.sha256: not a SHA-256`);
  }
  return problems;
}

/** Problems with a manifest, or none. */
export function validateToolchain(manifest: ToolchainManifest, target: string): string[] {
  const problems: string[] = [];
  if (manifest.schema !== TOOLCHAIN_SCHEMA) problems.push(`schema is ${manifest.schema}, not ${TOOLCHAIN_SCHEMA}`);
  if (manifest.target !== target) problems.push(`target is ${manifest.target}, not ${target}`);
  const names = new Set<string>();
  const rustupToolchains = new Set<string>();
  for (const [index, component] of manifest.components.entries()) {
    const where = `components[${index}] ${component.name}`;
    if (!NAME.test(component.name)) problems.push(`${where}: name is not lower-case words joined by -`);
    if (names.has(component.name)) problems.push(`${where}: name repeats`);
    names.add(component.name);
    if (!["toolchain", "run", "deploy"].includes(component.role)) problems.push(`${where}: unknown role ${component.role}`);
    for (const host of component.hosts ?? []) if (!HOST_IDS.includes(host)) problems.push(`${where}: unknown host ${host}`);
    switch (component.kind) {
      case "rustup":
        if (!RUSTUP_PIN.test(component.toolchain)) problems.push(`${where}: toolchain ${component.toolchain} is not a version or a dated channel`);
        rustupToolchains.add(component.toolchain);
        break;
      case "archive":
        problems.push(...sourceProblems(where, component.source));
        if (!["zip", "tar.gz", "tar.xz"].includes(component.format)) problems.push(`${where}: unknown format ${component.format}`);
        if (component.root !== undefined && !relativePath(component.root)) problems.push(`${where}: root is not a relative path`);
        if (component.markers.length === 0) problems.push(`${where}: no markers`);
        for (const marker of component.markers) if (!relativePath(marker)) problems.push(`${where}: marker ${marker} is not a relative path`);
        break;
      case "file":
        problems.push(...sourceProblems(where, component.source));
        if (!relativePath(component.file) || component.file.includes("/")) problems.push(`${where}: file is not a file name`);
        break;
      case "cargo-install":
        if (!GIT_REVISION.test(component.source.revision)) problems.push(`${where}: revision is not a full commit`);
        if (!rustupToolchains.has(component.toolchain)) {
          problems.push(`${where}: toolchain ${component.toolchain} is not installed by an earlier rustup component`);
        }
        if (component.binaries.length === 0) problems.push(`${where}: no binaries`);
        break;
      default:
        problems.push(`${where}: unknown kind ${(component as { kind: string }).kind}`);
    }
  }
  return problems;
}

export function appliesTo(component: Component, host: HostId): boolean {
  return !component.hosts || component.hosts.includes(host);
}

/** The source a component downloads on `host`, or undefined when it has none for it. */
export function sourceFor(sources: HostSources, host: HostId): Source | undefined {
  return "url" in sources ? sources as Source : (sources as Partial<Record<HostId, Source>>)[host];
}

/** The pin a component digest covers on `host`. */
export function componentPin(component: Component, host: HostId): Record<string, unknown> {
  const { name: _name, role: _role, hosts: _hosts, ...pin } = component;
  if (component.kind === "archive" || component.kind === "file") {
    return { ...pin, source: sourceFor(component.source, host) ?? null };
  }
  if (component.kind === "cargo-install") return { ...pin, host };
  return pin;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function componentDigest(component: Component, host: HostId): string {
  return sha256(canonicalJson(componentPin(component, host)));
}

/** The `toolchain` components a target needs on `host`. */
export function toolchainComponents(manifest: ToolchainManifest, host: HostId): Component[] {
  return manifest.components.filter((component) => component.role === "toolchain" && appliesTo(component, host));
}

export function toolchainDigest(manifest: ToolchainManifest, host: HostId): string {
  return sha256(canonicalJson({
    target: manifest.target,
    host,
    components: toolchainComponents(manifest, host).map((component) => ({
      name: component.name,
      digest: componentDigest(component, host),
    })),
  }));
}
