#!/usr/bin/env bun
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { STABLE_RUST_TOOLCHAIN } from "./build/toolchains/rust.ts";

const ROOT = resolve(import.meta.dir, "..");

/** Candidate-source check. Fixed Git identity is tested by test-out-of-tree-rust. */
export async function runDriverKitConsumer() {
  const output = join(ROOT, ".pocket-build/validation/driver-kit-rust", `${Date.now()}-${process.pid}`);
  const consumer = mkdtempSync(join(tmpdir(), "pocket-driver-kit-consumer-"));
  mkdirSync(output, { recursive: true });
  if (!relative(ROOT, consumer).startsWith("..")) throw new Error("consumer must be outside the checkout");
  const env = { ...process.env, CARGO_TARGET_DIR: join(ROOT, ".pocket-build/validation/driver-kit-rust/cargo-target"), RUSTC_WRAPPER: "", RUSTC_WORKSPACE_WRAPPER: "" };
  let index = 0;
  async function command(args: string[]) {
    const child = Bun.spawn(args, { cwd: consumer, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const log = join(output, `${++index}.log`);
    writeFileSync(log, "$ " + args.join(" ") + "\n" + stdout + stderr);
    if (code !== 0 || child.signalCode !== null) throw new Error(`driver kit consumer failed (exit=${code}, signal=${child.signalCode}): ${log}\n${stdout}${stderr}`);
    return stdout;
  }
  try {
    cpSync(join(ROOT, "tests/fixtures/out-of-tree-rust"), consumer, { recursive: true });
    cpSync(join(ROOT, "tests/fixtures/packages/corpus"), join(consumer, "corpus"), { recursive: true });
    cpSync(join(ROOT, "tests/fixtures/driver-kit-rust/probes.rs"), join(consumer, "tests/probes.rs"));
    const workspace = Bun.TOML.parse(readFileSync(join(ROOT, "Cargo.toml"), "utf8")) as { workspace: { dependencies: Record<string, { path: string }> } };
    const manifest = readFileSync(join(consumer, "Cargo.toml.in"), "utf8").replace(/^(pocket-[\w-]+) = \{ git = @GIT_URL@, rev = @REVISION@ \}$/gm, (_, name: string) => {
      const path = workspace.workspace.dependencies[name]?.path;
      if (!path) throw new Error(`missing public crate path: ${name}`);
      return `${name} = { path = ${JSON.stringify(join(ROOT, path))} }`;
    });
    writeFileSync(join(consumer, "Cargo.toml"), manifest);
    writeFileSync(join(output, "Cargo.toml"), manifest);
    const cargo = ["cargo", `+${STABLE_RUST_TOOLCHAIN}`];
    await command([...cargo, "generate-lockfile"]);
    const metadata = JSON.parse(await command([...cargo, "metadata", "--locked", "--format-version=1"])) as {
      workspace_members: string[];
      packages: { id: string; name: string; manifest_path: string; dependencies: { name: string }[] }[];
    };
    const product = metadata.packages.find(pkg => pkg.name === "pocket-out-of-tree-consumer");
    const kit = metadata.packages.find(pkg => pkg.name === "pocket-driver-kit");
    if (!product || metadata.workspace_members.length !== 1 || metadata.workspace_members[0] !== product.id || kit?.manifest_path !== join(ROOT, "engine/driver-kit/Cargo.toml")) {
      throw new Error("independent consumer did not resolve candidate driver-kit");
    }
    if (product.dependencies.some(dep => dep.name === "pocketjs-core")) throw new Error("consumer must use public contracts");
    const tests = await command([...cargo, "test", "--locked", "--offline", "--", "--nocapture"]);
    if (!tests.includes("6 passed; 0 failed") || !tests.includes("2 passed; 0 failed")) throw new Error("all eight consumer tests must execute");
    cpSync(join(consumer, "Cargo.lock"), join(output, "Cargo.lock"));
    const receipt = { mode: "current-path", consumerOutsideRepository: true, compiler: STABLE_RUST_TOOLCHAIN, tests: 8, result: "passed", output } as const;
    writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    return receipt;
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}
if (import.meta.main) console.log(JSON.stringify(await runDriverKitConsumer(), null, 2));
