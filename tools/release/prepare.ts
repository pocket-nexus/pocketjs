import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { checkReleaseVersion, normalizeReleaseVersion, releaseChannel, RELEASE_VERSION_FILES } from "../release-check.ts";
import { releaseNotes } from "../release-notes.ts";
import { STABLE_RUST_TOOLCHAIN } from "../build/toolchains/rust.ts";

const REPO = "pocket-nexus/pocketjs";
const root = resolve(import.meta.dir, "../..");
type Bump = "patch" | "minor" | "major";
const BUMPS = ["auto", "patch", "minor", "major"];
interface Commit { sha: string; subject: string; body: string }
interface CargoPackage { id: string; name: string; version: string; manifest_path: string }

function run(args: string[], cwd: string, optional = false): string {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (!result.success && !optional) throw new Error(`${args.slice(0, 3).join(" ")} failed:\n${result.stderr}`);
  return result.success ? result.stdout.toString().trim() : "";
}

export function bumpVersion(version: string, bump: Bump): string {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(`patch/minor/major require a stable current version; use auto or an exact version after ${version}`);
  }
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  return bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export function inferBump(commits: Commit[]): Bump {
  if (commits.some(c => /^[a-z]+(?:\([^\n)]*\))?!:/.test(c.subject) || /^BREAKING[ -]CHANGE:/m.test(c.body))) return "major";
  return commits.some(c => /^feat(?:\([^\n)]*\))?:/.test(c.subject)) ? "minor" : "patch";
}

function exactVersion(input: string): string {
  const version = normalizeReleaseVersion(input);
  if (version.includes("+")) throw new Error("Release versions cannot contain build metadata (+...)");
  return version;
}

export function selectVersion(current: string, requested: string, inferred: Bump): string {
  current = exactVersion(current);
  let next: string;
  if (!BUMPS.includes(requested)) next = exactVersion(requested);
  else if (requested === "auto" && current.includes("-")) {
    // Stay on the current prerelease line until an exact version is requested.
    const start = current.indexOf("-") + 1;
    const identifiers = current.slice(start).split(".");
    const last = identifiers.length - 1;
    if (/^\d+$/.test(identifiers[last]!)) identifiers[last] = String(BigInt(identifiers[last]!) + 1n);
    else identifiers.push("1");
    next = current.slice(0, start) + identifiers.join(".");
  } else {
    const bump = requested === "auto" ? inferred : requested as Bump;
    next = bumpVersion(current, requested === "auto" && current.startsWith("0.") && bump === "major" ? "minor" : bump);
  }
  if (Bun.semver.order(next, current) <= 0) throw new Error(`Release version ${next} must be greater than ${current}`);
  return next;
}

export function parseReleaseArgs(args: string[]) {
  let requested: string | undefined, cargoVersion: string | undefined, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--cargo-version" || arg.startsWith("--cargo-version=")) {
      if (cargoVersion !== undefined) throw new Error("--cargo-version can only be specified once");
      const value = arg === "--cargo-version" ? args[++i] : arg.slice("--cargo-version=".length);
      if (!value || value.startsWith("--")) throw new Error("--cargo-version requires an exact version");
      cargoVersion = exactVersion(value);
    } else if (arg.startsWith("-") || requested !== undefined) {
      throw new Error(`Unexpected release argument: ${arg}`);
    } else requested = BUMPS.includes(arg) ? arg : exactVersion(arg);
  }
  return { requested: requested ?? "auto", cargoVersion, dryRun };
}

export async function prepareRelease(cwd: string, requested = "auto", cargoOverride?: string) {
  const current = (await Bun.file(resolve(cwd, "package.json")).json()).version as string;
  await checkReleaseVersion(current, cwd);
  const previousTag = `v${current}`;
  run(["git", "rev-parse", "--verify", `refs/tags/${previousTag}^{commit}`], cwd);
  run(["git", "merge-base", "--is-ancestor", previousTag, "HEAD"], cwd);
  const records = run(["git", "log", "--reverse", "--format=%H%x00%s%x00%b%x00", `${previousTag}..HEAD`], cwd).split("\0");
  const commits: Commit[] = [];
  for (let i = 0; i + 2 < records.length; i += 3) {
    const commit = { sha: records[i]!.trim(), subject: records[i + 1]!, body: records[i + 2]! };
    if (!/^chore\(release\):/.test(commit.subject)) commits.push(commit);
  }
  if (commits.length === 0 && BUMPS.includes(requested)) throw new Error(`No unreleased commits after ${previousTag}; specify an exact version to promote the same source`);
  const inferred = inferBump(commits);
  const version = selectVersion(current, requested, inferred);
  const cargoPath = resolve(cwd, "Cargo.toml");
  const cargoText = await Bun.file(cargoPath).text();
  const manifest = Bun.TOML.parse(cargoText) as { workspace: { package: { version: string } } };
  const previousCargoVersion = manifest.workspace.package.version;
  const cargoVersion = selectVersion(previousCargoVersion, cargoOverride ?? requested, inferred);
  const cargo = ["rustup", "run", STABLE_RUST_TOOLCHAIN, "cargo"];
  const metadata = JSON.parse(run([...cargo, "metadata", "--locked", "--no-deps", "--format-version=1"], cwd)) as {
    packages: CargoPackage[]; workspace_members: string[];
  };
  const inherited = new Map<string, string>();
  for (const pkg of metadata.packages.filter(p => metadata.workspace_members.includes(p.id))) {
    const text = await Bun.file(pkg.manifest_path).text();
    const section = text.split(/^\[package\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
    const doc = Bun.TOML.parse(section) as { version?: { workspace?: boolean } | string };
    if (typeof doc.version === "object" && doc.version.workspace) {
      inherited.set(dirname(pkg.manifest_path), pkg.name);
    }
  }

  for (const file of RELEASE_VERSION_FILES) {
    const path = resolve(cwd, file);
    const before = await Bun.file(path).text();
    const after = before.replace(/(^[\t ]*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`);
    if (JSON.parse(after).version !== version) throw new Error(`Cannot update the root version in ${file}`);
    await Bun.write(path, after);
  }
  // Preserve TOML formatting and external dependency requirements.
  const manifests = run(["git", "ls-files", "Cargo.toml", "**/Cargo.toml"], cwd).split("\n");
  for (const file of manifests) {
    const path = resolve(cwd, file);
    let content = await Bun.file(path).text();
    if (file === "Cargo.toml") {
      content = content.replace(/(\[workspace\.package\][\s\S]*?^version\s*=\s*)"[^"]+"/m, `$1"${cargoVersion}"`);
    }
    content = content.split("\n").map(line => {
      const dependency = line.match(/\bpath\s*=\s*"([^"]+)"/);
      if (!dependency || !inherited.has(resolve(dirname(path), dependency[1]!))) return line;
      return line.replace(/(\bversion\s*=\s*)"[^"]+"/, `$1"${cargoVersion}"`);
    }).join("\n");
    if (content !== await Bun.file(path).text()) await Bun.write(path, content);
  }
  const names = new Set(inherited.values());
  for (const directory of inherited.keys()) {
    const readme = Bun.file(resolve(directory, "README.md"));
    if (!await readme.exists()) continue;
    const before = await readme.text();
    const after = before.replace(/^([\w-]+)(\s*=\s*)"[^"\n]+"/gm, (line, name: string, equals: string) =>
      names.has(name) ? `${name}${equals}"${cargoVersion}"` : line);
    if (after !== before) await Bun.write(readme, after);
  }
  // Isolated fixture workspaces also lock dependencies on these path packages.
  for (const lock of run(["git", "ls-files", "Cargo.lock", "**/Cargo.lock"], cwd).split("\n")) {
    run([...cargo, "update", "--workspace", "--manifest-path", resolve(cwd, dirname(lock), "Cargo.toml")], cwd);
  }
  run([...cargo, "metadata", "--locked", "--no-deps", "--format-version=1"], cwd);
  run(["bun", "install", "--lockfile-only", "--frozen-lockfile", "--ignore-scripts"], cwd);

  const date = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date());
  const sections: string[] = [];
  for (const [title, matches] of [
    ["Features", (c: Commit) => /^feat(?:\(|!?:)/.test(c.subject)],
    ["Fixes", (c: Commit) => /^fix(?:\(|!?:)/.test(c.subject)],
    ["Other changes", (c: Commit) => !/^(feat|fix)(?:\(|!?:)/.test(c.subject)],
  ] as const) {
    const rows = commits.filter(matches).map(c => `- ${c.subject} ([${c.sha.slice(0, 8)}](https://github.com/${REPO}/commit/${c.sha}))`);
    if (rows.length) sections.push(`### ${title}\n\n${rows.join("\n")}`);
  }
  if (!sections.length) sections.push(`No source changes since ${previousTag}.`);
  const entry = `## ${version} — ${date}\n\n${sections.join("\n\n")}\n\n`;
  const changelogPath = resolve(cwd, "site/content/changelog.md");
  const changelog = await Bun.file(changelogPath).text();
  const first = changelog.search(/^## /m);
  if (first < 0) throw new Error("The changelog has no release sections");
  if (changelog.includes(`## ${version} `)) throw new Error(`Changelog already contains ${version}`);
  const nextChangelog = changelog.slice(0, first) + entry + changelog.slice(first);
  await Bun.write(changelogPath, nextChangelog);
  await checkReleaseVersion(version, cwd);
  releaseNotes(nextChangelog, version);
  run(["git", "diff", "--check"], cwd);
  const files = run(["git", "diff", "--name-only"], cwd).split("\n").filter(Boolean);
  return { version, cargoVersion, previousVersion: current, previousCargoVersion,
    baseCommit: run(["git", "rev-parse", "HEAD"], cwd), files, notes: entry };
}

async function main() {
  const args = Bun.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: bun run release [auto|patch|minor|major|VERSION] [--cargo-version VERSION] [--dry-run]\nExact versions (including beta/rc) apply to npm and Cargo unless --cargo-version overrides Cargo.\nAuto continues a prerelease's numeric suffix; use an exact version to change channel or graduate.\nCreates a release PR from origin/main. --dry-run prepares a local preview from HEAD.");
    return;
  }
  const { requested, cargoVersion, dryRun } = parseReleaseArgs(args);
  if (!dryRun) {
    const open = JSON.parse(run(["gh", "pr", "list", "--repo", REPO, "--base", "main", "--state", "open", "--limit", "100", "--json", "headRefName,url"], root)) as { headRefName: string; url: string }[];
    const existing = open.find(pr => /^release\/v\d+\./.test(pr.headRefName));
    if (existing) { console.log(`Release PR already open: ${existing.url}`); return; }
    run(["git", "fetch", "origin", "main", "--tags"], root);
    run(["git", "cat-file", "-e", "origin/main:tools/release/prepare.ts"], root);
  }
  const output = resolve(root, ".pocket-build/validation/release-prepare", new Date().toISOString().replaceAll(":", "-") + `-${process.pid}`);
  const worktree = resolve(output, "source");
  await mkdir(output, { recursive: true });
  run(["git", "worktree", "add", "--detach", worktree, dryRun ? "HEAD" : "origin/main"], root);
  try {
    const plan = await prepareRelease(worktree, requested, cargoVersion);
    const title = `chore(release): v${plan.version}`;
    const body = `Release ${plan.version}. Merging this PR into main tags the merge commit and runs the repository release workflow.\n\n- npm packages (@pocketjs/framework, @pocketjs/cli): ${plan.previousVersion} → ${plan.version}\n- Cargo workspace: ${plan.previousCargoVersion} → ${plan.cargoVersion}\n- npm channel: ${releaseChannel(plan.version)}\n- Requested: ${requested}${cargoVersion ? `; Cargo ${cargoVersion}` : ""}\n- Prepared from: ${plan.baseCommit}\n\nCargo workspace lock update, Bun frozen lockfile check, version consistency, and changelog validation passed.\n\n${plan.notes}`;
    const bodyFile = resolve(output, "PR_BODY.md");
    await Bun.write(bodyFile, body);
    console.log(`${title}; Cargo ${plan.cargoVersion}\n${run(["git", "diff", "--stat"], worktree)}`);
    if (dryRun) { console.log(`Preview: ${worktree}\nPR body: ${bodyFile}`); return; }
    const branch = `release/v${plan.version}`;
    run(["git", "switch", "-c", branch], worktree);
    run(["git", "add", "--", ...plan.files], worktree);
    run(["git", "commit", "-m", title], worktree);
    run(["git", "push", "-u", "origin", branch], worktree);
    console.log(run(["gh", "pr", "create", "--repo", REPO, "--base", "main", "--head", branch, "--title", title, "--body-file", bodyFile], worktree));
    run(["git", "worktree", "remove", worktree], root);
  } catch (error) {
    console.error(`Release preparation retained at ${worktree}`);
    throw error;
  }
}

if (import.meta.main) await main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
