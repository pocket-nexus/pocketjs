import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exportSdk, parseSdkExport } from "../tools/sdk.ts";

const root = resolve(import.meta.dir, "..");
const artifacts = join(root, ".pocket-build/validation/sdk-idf", `host-test-${Date.now()}-${process.pid}`);
mkdirSync(artifacts, { recursive: true });
function run(args: string[], name: string): string {
  const result = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(join(artifacts, `${name}.log`), output);
  expect(result.success, `${name}: exit=${result.exitCode}, signal=${result.signalCode}\n${output.slice(-8000)}`).toBe(true);
  return result.stdout.toString();
}

test.skipIf(!Bun.which("cmake") || !Bun.which("cc"))(
  "external IDF C consumer agrees across whole/strip/mixed rendering and recovers terminal errors",
  async () => {
    const triple = /^host: (.+)$/m.exec(run(["rustup", "run", "stable", "rustc", "-Vv"], "rustc"))![1]!;
    const sdk = join(artifacts, "sdk");
    await exportSdk(parseSdkExport(["--triple", triple, "--out", sdk]));
    let quickjs = process.env.POCKET_QJS_SOURCE;
    if (!quickjs) {
      const metadata = JSON.parse(run(["cargo", "+stable", "metadata", "--locked", "--format-version=1", "--manifest-path", "Cargo.toml"], "metadata"));
      const dependency = metadata.packages.find((pkg: { name: string }) => pkg.name === "rquickjs-sys");
      if (!dependency) throw new Error("locked workspace has no rquickjs-sys source");
      quickjs = join(dirname(dependency.manifest_path), "quickjs");
    }
    run(["bun", "tools/test-sdk-idf.ts", "--host-sdk", sdk, "--quickjs", quickjs!, "--host-only", "--artifacts", artifacts], "consumer");
    const receipt = JSON.parse(readFileSync(join(artifacts, "build-receipt.json"), "utf8"));
    expect(receipt.status).toBe("passed");
    expect(receipt.external.startsWith(root)).toBe(false);
    expect(receipt.hostPpa).toBe("mock; not hardware evidence");
    expect(receipt.hostResult).toContain("SDK consumer passed:");
    expect(receipt.hostResult).toContain("strip_bytes=256 full_bytes=1536");
    expect(receipt.hostResult).toContain("failures=2");
  }, 240_000,
);
