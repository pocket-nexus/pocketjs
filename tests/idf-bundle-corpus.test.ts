import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bundleCorpus } from "../tools/bundle-corpus.ts";
import { decodeBundle } from "../contracts/spec/bundle.ts";

const root = new URL("..", import.meta.url).pathname;
test("TS, Rust and Python consume the shared bundle corpus", () => {
  const corpus = join(root, "tests/fixtures/bundles/corpus");
  const run = (cmd: string[]) => {
    const result = Bun.spawnSync(cmd, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(result.success, result.stdout.toString() + result.stderr.toString()).toBe(true);
  };
  run(["cargo", "+stable", "test", "--locked", "--manifest-path", join(root, "Cargo.toml"), "-p", "pocket-package", "shared_malformed_corpus"]);
  for (const [name, expected] of bundleCorpus()) {
    const bytes = readFileSync(join(corpus, name));
    expect(bytes.equals(Buffer.from(expected)), name).toBe(true);
    if (name.startsWith("ok-")) expect(() => decodeBundle(bytes), name).not.toThrow();
    else expect(() => decodeBundle(bytes), name).toThrow();
  }
  run(["python3", join(root, "tests/esp-idf/host/bundle_corpus.py"),
    join(root, "platforms/esp-idf/pocket_runtime/tools"), corpus]);
}, 60_000);
