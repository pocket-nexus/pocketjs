// tools/targets/commands.ts — `pocket target add|list|remove` and the
// `status` query `pocket show` reads.
//
//   target add [<id> …]       install the toolchains; with no id, the targets of
//                             the project's pocket.config.ts
//   target list [--check] [--json]
//                             every catalog target with its install state;
//                             --check exits 1 unless every target of
//                             pocket.config.ts is ready to build
//   target remove <id> …      delete the install records, prune the store
//   status --json             the rows of `target list` as JSON

import { CATALOG, catalogEntry } from "./index.ts";
import { addTarget, InstallError, removeTarget } from "./install.ts";
import { loadProject, type ProjectConfiguration } from "./project.ts";
import { stateMessage, targetState, type TargetState } from "./store.ts";
import type { TargetDescriptor } from "./types.ts";

export interface StatusRow {
  readonly id: string;
  readonly title: string;
  readonly hosts: readonly string[];
  readonly state: TargetState["state"] | "host profile";
  readonly digest?: string;
  readonly components?: number;
  /** What the state means, and the command that changes it. */
  readonly detail: string;
}

function row(descriptor: TargetDescriptor, state: TargetState): StatusRow {
  const base = { id: descriptor.id, title: descriptor.title, hosts: descriptor.hosts, state: state.state };
  const add = `pocket target add ${descriptor.id}`;
  switch (state.state) {
    case "installed": {
      const components = Object.keys(state.record.components).length;
      return { ...base, digest: state.digest, components, detail: `toolchain ${state.digest.slice(0, 8)}, ${components} components` };
    }
    case "not installed":
      return { ...base, digest: state.digest, detail: add };
    case "outdated":
      return {
        ...base,
        digest: state.digest,
        detail: `installed for toolchain ${state.installed.digest.slice(0, 8)} (${state.installed.framework.version}); ${add}`,
      };
    case "broken":
      return { ...base, digest: state.digest, detail: `${state.missing.length} component(s) gone; ${add}` };
    case "unsupported":
      return { ...base, detail: `installs on ${state.hosts.join(", ")}` };
    case "nothing to install":
      return { ...base, digest: state.digest, detail: "the compiler builds it" };
    case "no manifest":
      return { ...base, detail: "its build script finds its own tools" };
  }
}

/** One row per catalog target, then one per host profile of the project. */
export function statusRows(project: ProjectConfiguration | null): StatusRow[] {
  const rows = CATALOG.map((descriptor) => row(descriptor, targetState(descriptor)));
  for (const target of project?.targets ?? []) {
    if (!target.hostProfile) continue;
    rows.push({ id: target.id, title: "ESP-IDF host profile", hosts: [], state: "host profile", detail: target.hostProfile });
  }
  return rows;
}

/** A row is ready when `pocket build` for it needs nothing more installed. */
function ready(row: StatusRow): boolean {
  return row.state === "installed" || row.state === "nothing to install" || row.state === "host profile";
}

async function projectHere(): Promise<ProjectConfiguration> {
  const result = await loadProject(process.cwd());
  if (!result.ok) throw new InstallError(result.diagnostics.join("\n"));
  return result.project;
}

async function add(ids: string[]): Promise<number> {
  let requested = ids;
  if (requested.length === 0) {
    const project = await projectHere();
    if (project.targets.length === 0) {
      throw new InstallError(`name the targets to install, or list them in pocket.config.ts (${project.config ?? "none found"})`);
    }
    for (const target of project.targets.filter((entry) => entry.hostProfile)) {
      console.log(`· ${target.id}  ESP-IDF host profile; the compiler builds it`);
    }
    requested = project.targets.filter((entry) => !entry.hostProfile).map((entry) => entry.id);
  }
  let failed = 0;
  for (const id of requested) {
    const descriptor = catalogEntry(id);
    if (!descriptor) {
      console.error(`✗ unknown target ${id}; targets: ${CATALOG.map((entry) => entry.id).join(", ")}`);
      failed++;
      continue;
    }
    if (!descriptor.toolchain) {
      console.error(`✗ ${id}: this framework has no toolchain manifest for ${id}; its build script finds its own tools`);
      failed++;
      continue;
    }
    if (descriptor.toolchain.components.length === 0) {
      console.log(`· ${id}  nothing to install; the compiler builds it`);
      continue;
    }
    console.log(`${id} (${descriptor.title})`);
    try {
      const record = await addTarget(descriptor);
      console.log(`✓ ${id} installed (toolchain ${record.digest.slice(0, 8)})`);
    } catch (error) {
      if (!(error instanceof InstallError)) throw error;
      console.error(`✗ ${id}: ${error.message}`);
      failed++;
    }
  }
  return failed > 0 ? 1 : 0;
}

async function list(flags: string[]): Promise<number> {
  const project = await projectHere();
  const rows = statusRows(project);
  if (flags.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else for (const item of rows) console.log(`${item.id.padEnd(20)} ${item.state.padEnd(18)} ${item.detail}`);
  if (!flags.includes("--check")) return 0;
  if (project.targets.length === 0) {
    console.error(`--check reads the targets of pocket.config.ts, and ${project.config ?? "no pocket.config.ts"} lists none`);
    return 1;
  }
  const projectIds = new Set(project.targets.map((target) => target.id));
  const notReady = rows.filter((item) => projectIds.has(item.id) && !ready(item));
  for (const item of notReady) {
    const descriptor = catalogEntry(item.id)!;
    console.error(stateMessage(descriptor, targetState(descriptor)) ?? `target ${item.id}: ${item.detail}`);
  }
  return notReady.length > 0 ? 1 : 0;
}

async function remove(ids: string[]): Promise<number> {
  if (ids.length === 0) throw new InstallError("usage: pocket target remove <id> …");
  for (const id of ids) {
    if (!catalogEntry(id)) throw new InstallError(`unknown target ${id}`);
    const { records, pruned } = await removeTarget(id);
    console.log(`✓ ${id}: ${records} install record(s) removed, ${pruned.length} store entr${pruned.length === 1 ? "y" : "ies"} pruned`);
  }
  return 0;
}

/** Runs `target <action> …`; returns the exit status. */
export async function targetCommand(args: readonly string[]): Promise<number> {
  const [action, ...rest] = args;
  const flags = rest.filter((value) => value.startsWith("--"));
  const ids = rest.filter((value) => !value.startsWith("--"));
  const accepted = action === "list" ? ["--check", "--json"] : [];
  const unknown = flags.find((flag) => !accepted.includes(flag));
  if (unknown) {
    console.error(`✗ pocket target ${action ?? ""}: unknown option ${unknown}`);
    return 1;
  }
  try {
    switch (action) {
      case "add":
        return await add(ids);
      case "list":
        return await list(flags);
      case "remove":
        return await remove(ids);
      default:
        console.error("usage: pocket target add [<id> …] | list [--check] [--json] | remove <id> …");
        return 1;
    }
  } catch (error) {
    if (!(error instanceof InstallError)) throw error;
    console.error(`✗ ${error.message}`);
    return 1;
  }
}
