import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkReleaseVersion, normalizeReleaseVersion, releaseChannel } from "../release-check.ts";
import { releaseNotes } from "../release-notes.ts";

function git(args: string[], cwd: string, optional = false): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (!result.success && !optional) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.success ? result.stdout.toString().trim() : "";
}

export async function releaseIdentity(cwd: string, event: string, ref: string, input?: string, createTag = false, before?: string) {
  if (git(["status", "--porcelain"], cwd)) throw new Error("Release identity requires a clean committed source tree");
  const fromMerge = event === "push" && ref === "refs/heads/main";
  let version: string;
  if (fromMerge) {
    if (!before || !/^[a-f0-9]{40}$/.test(before) || /^0+$/.test(before)) {
      throw new Error("Main push requires the previous commit from the push event");
    }
    git(["merge-base", "--is-ancestor", before, "HEAD"], cwd);
    version = normalizeReleaseVersion((await Bun.file(resolve(cwd, "package.json")).json()).version);
    const previousVersion = normalizeReleaseVersion(JSON.parse(git(["show", `${before}:package.json`], cwd)).version);
    if (version === previousVersion) return { release: false as const };
    if (Bun.semver.order(version, previousVersion) <= 0) {
      throw new Error("Release must advance the package version");
    }
    const cargo = Bun.TOML.parse(await Bun.file(resolve(cwd, "Cargo.toml")).text()) as { workspace: { package: { version: string } } };
    const previousCargo = Bun.TOML.parse(git(["show", `${before}:Cargo.toml`], cwd)) as typeof cargo;
    const cargoVersion = normalizeReleaseVersion(cargo.workspace.package.version);
    const previousCargoVersion = normalizeReleaseVersion(previousCargo.workspace.package.version);
    if (Bun.semver.order(cargoVersion, previousCargoVersion) <= 0) {
      throw new Error("Release must advance the Cargo workspace version");
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
  const npmTag = releaseChannel(version);
  return { release: true as const, version, tag, commit: head, npmTag, prerelease: npmTag !== "latest" };
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.some(arg => arg !== "--create-tag")) throw new Error("Usage: bun tools/release/identity.ts [--create-tag]");
    const identity = await releaseIdentity(resolve(import.meta.dir, "../.."), process.env.GITHUB_EVENT_NAME ?? "", process.env.GITHUB_REF ?? "", process.env.RELEASE_INPUT, args.includes("--create-tag"), process.env.RELEASE_BEFORE);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      `release=${identity.release}\n` + (identity.release ? `version=${identity.version}\ntag=${identity.tag}\nnpm-tag=${identity.npmTag}\nprerelease=${identity.prerelease}\n` : ""));
    console.log(identity.release ? `Release ${identity.tag} from ${identity.commit}` : "Package version unchanged; skipping release");
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
