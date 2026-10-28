import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

test.skipIf(!process.env.POCKET_WORKER_QUICKJS_SOURCE)("3DS worker console mount propagates allocation failures", () => {
  const root = resolve(import.meta.dir, "..");
  const source = resolve(process.env.POCKET_WORKER_QUICKJS_SOURCE!);
  const output = resolve(root, ".pocket-build/validation/worker/network/oom");
  mkdirSync(output, { recursive: true });
  const bellard = process.env.POCKET_WORKER_QUICKJS_ENGINE === "bellard";
  const flags = bellard ? ["-DPOCKET_QJS_BELLARD", "-DJS_NO_NAN_BOXING"] : [];
  const sources = ["quickjs", "dtoa", "libregexp", "libunicode", ...(bellard ? ["cutils"] : [])];
  const executable = resolve(output, "3ds-worker-oom");
  const compile = Bun.spawnSync([
    process.env.CC ?? "cc", "-std=gnu11", "-O1", "-D_GNU_SOURCE", '-DCONFIG_VERSION="test"',
    "-ffunction-sections", "-fdata-sections", process.platform === "darwin" ? "-Wl,-dead_strip" : "-Wl,--gc-sections",
    ...flags, `-I${source}`, `-I${root}/tests/fixtures/3ds-worker-oom`,
    `-I${root}/engine/worker/include`, `-I${root}/engine/host-services`,
    resolve(root, "tests/fixtures/3ds-worker-oom/main.c"), resolve(root, "engine/worker/src/worker.c"),
    ...sources.map(name => resolve(source, `${name}.c`)), "-lm", "-lpthread", "-o", executable,
  ]);
  writeFileSync(resolve(output, "compile.log"), compile.stdout.toString() + compile.stderr.toString());
  expect(compile.exitCode, compile.stderr.toString()).toBe(0);
  const run = Bun.spawnSync([executable]);
  writeFileSync(resolve(output, "run.log"), run.stdout.toString() + run.stderr.toString());
  expect(run.exitCode, run.stdout.toString() + run.stderr.toString()).toBe(0);
}, 120_000);
