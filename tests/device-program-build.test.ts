import { STABLE_RUST_TOOLCHAIN } from "../tools/build/toolchains/rust.ts";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import type { RuntimeBuildContext } from "../framework/src/host-config.ts";
import { prepareApplication } from "../tools/build/inputs.ts";
import { applicationBundle, prepareCompiledApplication } from "../tools/build/programs/application.ts";
import { buildPocketBook } from "../tools/build/programs/pocketbook-native.ts";
import { buildRuntime } from "../tools/build/executor.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { profileRegistry, resolveProfile, type ResolvedProfile } from "../tools/profile-resolver.ts";
import { mustRunCommand } from "../tools/native-source.ts";

const root = resolve(import.meta.dir, "..");
const base = join(root, ".pocket-build/validation/runtime-build/device-tests");
mkdirSync(base, { recursive: true });
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function scratch() { const path = mkdtempSync(join(base, "run-")); temporary.push(path); return path; }
const programs = ["pocketbook", "moto-g-play", "redmi-1s", "blackberry-classic", "meizu-m8", "nokia-e7", "ios-simulator", "iphone2g", "iphone4s", "ipodtouch6", "ipodtouch4"];
const generic = new Set(["moto-g-play", "redmi-1s", "ipodtouch4"]);
function select(id: string) { return resolveProfile({ from: root, hostConfig: join(root, `programs/${id}/pocket.host.config.ts`), requireConfig: true }); }
function packageFixture(selected: ResolvedProfile, directory: string) {
  const manifest = {
    $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2, id: "dev.pocketjs.native-input", title: "Current package", version: "1.2.3",
    engine: { capabilities: { requires: ["text.glyphs.baked"] } },
    app: { entry: "source-does-not-exist.tsx", output: "current-package", framework: "solid", viewport: { fixed: {
      logical: selected.profile.display.logicalViewports[0], presentation: selected.profile.display.presentations[0],
    } } },
  };
  const result = validateAndResolveBuildPlan(manifest, { target: selected.profile.id }, profileRegistry(selected.profile));
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
  const variant = makeVariant({ target: selected.profile.id, hostAbi: POCKET_BINDING_GENERATION, planJson: JSON.stringify(result.plan),
    identity: { output: result.plan.app.output, id: result.plan.app.id, title: result.plan.app.title },
    js: new TextEncoder().encode("globalThis.currentPackage = 73;"), pak: new Uint8Array([7, 3, 1]) });
  const path = join(directory, "current.pocket");
  writeFileSync(path, encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)), variants: [variant] }));
  return path;
}

test("device recipes reject missing package inputs before generating native headers", async () => {
  const dir = scratch();
  for (const id of programs) {
    const selected = await select(id);
    if (!generic.has(id)) {
      await expect(buildRuntime(selected, join(dir, id))).rejects.toThrow("--pocket");
      expect(existsSync(join(dir, id, "pocket_profile.h"))).toBe(false);
    }
  }
}, 60_000);

test("native compatibility inputs consume the current package without source files or default demos", async () => {
  const directory = scratch();
  const selected = await select("iphone2g");
  const packagePath = packageFixture(selected, directory);
  const application = prepareCompiledApplication(selected.profile, ["--pocket", packagePath], join(directory, "out"));
  const bundle = applicationBundle(application, selected.profile.id);
  expect(bundle.inputs.appOutput).toBe("current-package");
  expect(readFileSync(bundle.javaScript, "utf8")).toBe("globalThis.currentPackage = 73;");
  expect([...readFileSync(bundle.pack)]).toEqual([7, 3, 1]);
  expect(() => prepareCompiledApplication(selected.profile, [], directory)).toThrow("requires --pocket");
  expect(() => applicationBundle(application, "iphone4s-dev")).toThrow();
});

test("PocketBook stages the selected package and launcher after the native Cargo step", async () => {
  const directory = scratch();
  const selected = await select("pocketbook");
  const application = prepareApplication(selected, packageFixture(selected, directory), directory);
  const bin = join(directory, "bin"); mkdirSync(bin);
  for (const name of ["cargo-zigbuild", "zig"]) { const path = join(bin, name); writeFileSync(path, "#!/bin/sh\nexit 1\n"); chmodSync(path, 0o755); }
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  let calls = 0;
  try {
    const context: RuntimeBuildContext = { profile: selected.profile, profileHash: selected.profileHash, application,
      configDirectory: directory, outdir: directory, output: application.plan.app.output, args: [], env: {}, toolchainPaths: {},
      async run(command, options) {
        calls++;
        expect(command.slice(0, 3)).toEqual(["cargo", "+" + STABLE_RUST_TOOLCHAIN, "zigbuild"]);
        expect(command).toContain("--locked");
        expect(command).toContain("armv7-unknown-linux-gnueabi.2.23");
        const artifact = join(options!.env!.CARGO_TARGET_DIR!, "armv7-unknown-linux-gnueabi/release");
        mkdirSync(artifact, { recursive: true }); writeFileSync(join(artifact, "pocketbook-host"), "native fixture");
      },
    };
    await buildPocketBook(context);
    expect(calls).toBe(1);
    expect(readFileSync(join(directory, "application/current-package/app.js"), "utf8")).toBe("globalThis.currentPackage = 73;");
    expect([...readFileSync(join(directory, "application/current-package/app.pak"))]).toEqual([7, 3, 1]);
    expect(readFileSync(join(directory, "application/current-package.app"), "utf8")).toContain('exec ./pocketbook-host');
  } finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});

test("native process failures include signal termination even when Bun reports exit code zero", () => {
  expect(() => mustRunCommand("native fixture", process.execPath, ["-e", 'process.kill(process.pid, "SIGABRT")'], root)).toThrow("failed");
});
