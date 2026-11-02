import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkReleaseVersion, normalizeReleaseVersion } from "../release-check.ts";
import { releaseNotes } from "../release-notes.ts";

function git(args: string[], cwd: string, optional = false): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (!result.success && !optional) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.success ? result.stdout.toString().trim() : "";
}

export async function releaseIdentity(cwd: string, event: string, ref: string, input?: string, createTag = false) {
  const fromMerge = event === "push" && ref === "refs/heads/main";
  let version: string;
  if (fromMerge) {
    const marker = await Bun.file(resolve(cwd, ".github/release.json")).json();
    if (marker.schema !== 1 || typeof marker.baseCommit !== "string" || !/^[a-f0-9]{40}$/.test(marker.baseCommit)) {
      throw new Error("Invalid release PR manifest");
    }
    version = normalizeReleaseVersion(marker.version);
    const cargo = Bun.TOML.parse(await Bun.file(resolve(cwd, "Cargo.toml")).text()) as { workspace: { package: { version: string } } };
    if (cargo.workspace.package.version !== marker.cargoVersion) throw new Error("Cargo version differs from the release PR manifest");
    git(["merge-base", "--is-ancestor", marker.baseCommit, "HEAD"], cwd);
    const previous = JSON.parse(git(["show", `${marker.baseCommit}:package.json`], cwd));
    const previousCargo = Bun.TOML.parse(git(["show", `${marker.baseCommit}:Cargo.toml`], cwd)) as { workspace: { package: { version: string } } };
    if (previous.version !== marker.previousVersion || !Bun.semver.satisfies(version, `>${previous.version}`)) {
      throw new Error("Release PR does not advance the base version");
    }
    if (previousCargo.workspace.package.version !== marker.previousCargoVersion || !Bun.semver.satisfies(marker.cargoVersion, `>${marker.previousCargoVersion}`)) {
      throw new Error("Release PR does not advance the Cargo workspace version");
    }
  } else {
    version = normalizeReleaseVersion(event === "workflow_dispatch" ? input ?? "" : ref.replace(/^refs\/tags\//, ""));
  }
  await checkReleaseVersion(version, cwd);
  releaseNotes(await Bun.file(resolve(cwd, "site/content/changelog.md")).text(), version);
  const tag = `v${version}`;
  const head = git(["rev-parse", "HEAD"], cwd);
  const tagged = git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], cwd, true);
  if (tagged && tagged !== head) throw new Error(`${tag} already points to another commit`);
  if (!fromMerge && !tagged) throw new Error(`${tag} must exist for a tag/manual release`);
  if (fromMerge && !tagged && createTag) {
    git(["tag", tag, head], cwd);
    git(["push", "origin", `refs/tags/${tag}`], cwd);
  }
  return { version, tag, commit: head };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.some(arg => arg !== "--create-tag")) throw new Error("Usage: bun tools/release/identity.ts [--create-tag]");
    const identity = await releaseIdentity(resolve(import.meta.dir, "../.."), process.env.GITHUB_EVENT_NAME ?? "", process.env.GITHUB_REF ?? "", process.env.RELEASE_INPUT, args.includes("--create-tag"));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${identity.version}\ntag=${identity.tag}\n`);
    console.log(`Release ${identity.tag} from ${identity.commit}`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
