#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dir, "..");
const DIRECT_CRATES = [
  "pocket-drivers", "pocket-runtime", "pocket-present", "pocket-package",
  "pocket-spec", "pocket-draw-ops", "pocket-tex-cache",
] as const;
interface CargoPackage {
  id: string;
  name: string;
  source: string | null;
  manifest_path: string;
  dependencies: { name: string; source: string | null; path?: string }[];
}
interface CargoMetadata {
  packages: CargoPackage[];
  workspace_members: string[];
  resolve: { root: string; nodes: { id: string; dependencies: string[] }[] };
}
export interface RustConsumerReceipt {
  schemaVersion: 1;
  revision: string;
  gitUrl: string;
  consumerOutsideRepository: true;
  directCrates: readonly string[];
  gitCrates: { name: string; source: string }[];
  lockSha256: string;
  compiler: string;
  tests: number;
  packageVersion: 1 | 2;
  result: "passed";
  artifactDirectory: string;
}
export async function runOutOfTreeRust(options: {
  repository?: string;
  revision?: string;
  output?: string;
} = {}): Promise<RustConsumerReceipt> {
  const repository = resolve(options.repository ?? ROOT);
  const head = options.revision === undefined
    ? Bun.spawnSync(["git", "-C", repository, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" })
    : undefined;
  if (head && !head.success) throw new Error(`cannot resolve repository HEAD (exit=${head.exitCode}, signal=${head.signalCode}): ${head.stderr}`);
  const revision = options.revision ?? head!.stdout.toString().trim();
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("revision must be a full commit hash");
  const gitUrl = pathToFileURL(repository).href;
  const output = resolve(options.output ?? join(ROOT, ".pocket-build/validation/out-of-tree-rust", Date.now() + "-" + process.pid));
  mkdirSync(output, { recursive: true });
  const consumer = mkdtempSync(join(tmpdir(), "pocket-out-of-tree-rust-"));
  if (!relative(repository, consumer).startsWith("..")) throw new Error("consumer must be outside the checkout");
  const environment = {
    ...process.env,
    CARGO_TARGET_DIR: join(output, "cargo-target"),
    // Parent workspace wrappers must not inject checkout sources.
    RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "",
  };
  let commandIndex = 0;
  async function command(args: string[]): Promise<string> {
    const log = join(output, String(++commandIndex).padStart(2, "0") + "-" + args[0]!.replaceAll("/", "_") + ".log");
    const child = Bun.spawn(args, { cwd: consumer, env: environment, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    writeFileSync(log, "$ " + args.join(" ") + "\n" + stdout + stderr);
    if (status !== 0 || child.signalCode !== null) throw new Error(args.join(" ") + " failed (exit=" + status + ", signal=" + child.signalCode + "); " + log + "\n" + stdout + stderr);
    return stdout;
  }
  try {
    cpSync(join(ROOT, "tests/fixtures/out-of-tree-rust"), consumer, { recursive: true });
    // Historical API replay uses that revision's package format and corpus.
    // Current source is exercised after its commit, at the resolved HEAD.
    const spec = await command(["git", "-C", repository, "show", revision + ":contracts/spec/pocket-package.ts"]);
    const packageVersion = /POCKET_PACKAGE_VERSION = 1;/.test(spec) ? 1 : 2;
    if (packageVersion === 1) {
      copyFileSync(join(consumer, "consumer-v1.rs.in"), join(consumer, "tests/consumer.rs"));
      mkdirSync(join(consumer, "corpus"), { recursive: true });
      const files = await command(["git", "-C", repository, "ls-tree", "--name-only", revision + ":tests/fixtures/packages/corpus"]);
      for (const name of files.trim().split("\n").filter(name => name.endsWith(".pocket"))) {
        const result = Bun.spawnSync(["git", "-C", repository, "show", revision + ":tests/fixtures/packages/corpus/" + name], { stdout: "pipe", stderr: "pipe" });
        if (!result.success) throw new Error(`cannot read historical corpus (${result.signalCode}): ${result.stderr}`);
        writeFileSync(join(consumer, "corpus", name), result.stdout);
      }
    } else {
      cpSync(join(ROOT, "tests/fixtures/packages/corpus"), join(consumer, "corpus"), { recursive: true });
    }
    const manifest = readFileSync(join(consumer, "Cargo.toml.in"), "utf8")
      .replaceAll("@GIT_URL@", JSON.stringify(gitUrl))
      .replaceAll("@REVISION@", JSON.stringify(revision));
    writeFileSync(join(consumer, "Cargo.toml"), manifest);
    writeFileSync(join(output, "Cargo.toml"), manifest);
    const compiler = (await command(["rustc", "+stable", "-Vv"])).trim();
    await command(["cargo", "+stable", "generate-lockfile", "--manifest-path", join(consumer, "Cargo.toml")]);
    const json = await command(["cargo", "+stable", "metadata", "--locked", "--offline", "--format-version=1"]);
    writeFileSync(join(output, "cargo-metadata.json"), json);
    const metadata = JSON.parse(json) as CargoMetadata;
    const root = metadata.packages.find(pkg => pkg.id === metadata.resolve.root);
    if (!root || root.name !== "pocket-out-of-tree-consumer" || root.source !== null ||
        metadata.workspace_members.length !== 1 || metadata.workspace_members[0] !== root.id) {
      throw new Error("consumer unexpectedly joined another workspace");
    }
    const expectedSource = "git+" + gitUrl + "?rev=" + revision + "#" + revision;
    const direct = root.dependencies.map(dep => dep.name).sort();
    if (JSON.stringify(direct) !== JSON.stringify([...DIRECT_CRATES].sort()) ||
        root.dependencies.some(dep => dep.path !== undefined || dep.source !== "git+" + gitUrl + "?rev=" + revision)) {
      throw new Error("consumer direct dependencies must be the public git crates");
    }
    const gitCrates = metadata.packages.filter(pkg => pkg.name.startsWith("pocket"));
    for (const pkg of gitCrates) {
      if (pkg.id === root.id) continue;
      if (pkg.source !== expectedSource || !relative(repository, pkg.manifest_path).startsWith("..")) {
        throw new Error("dependency did not resolve from the fixed git snapshot: " + pkg.name + ": " + pkg.source);
      }
    }
    if (metadata.packages.some(pkg => pkg.id !== root.id && pkg.source === null)) {
      throw new Error("consumer resolved a local path dependency");
    }
    const tests = await command(["cargo", "+stable", "test", "--locked", "--offline", "--", "--nocapture"]);
    if (!tests.includes("6 passed; 0 failed")) throw new Error("all six independent consumer cases must execute");
    cpSync(join(consumer, "Cargo.lock"), join(output, "Cargo.lock"));
    const receipt: RustConsumerReceipt = {
      schemaVersion: 1, revision, gitUrl, consumerOutsideRepository: true,
      directCrates: DIRECT_CRATES,
      gitCrates: gitCrates.filter(pkg => pkg.id !== root.id).map(pkg => ({ name: pkg.name, source: pkg.source! })).sort((a, b) => a.name.localeCompare(b.name)),
      lockSha256: createHash("sha256").update(readFileSync(join(consumer, "Cargo.lock"))).digest("hex"),
      compiler,
      tests: 6, packageVersion, result: "passed", artifactDirectory: output,
    };
    writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    return receipt;
  } finally {
    if (existsSync(join(consumer, "Cargo.lock"))) cpSync(join(consumer, "Cargo.lock"), join(output, "Cargo.lock"));
    rmSync(consumer, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const options: { repository?: string; revision?: string; output?: string } = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]!;
    const value = args[i + 1];
    if (!value || !["--repository", "--revision", "--output"].includes(name)) {
      throw new Error("usage: test-out-of-tree-rust [--repository path] [--revision full-commit] [--output directory]");
    }
    options[name.slice(2) as keyof typeof options] = value;
  }
  const receipt = await runOutOfTreeRust(options);
  console.log("Independent Rust consumer: " + receipt.tests + " cases passed at " + receipt.revision + "; " + receipt.artifactDirectory);
}
