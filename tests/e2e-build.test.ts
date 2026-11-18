import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { decodePocketPackage, decodeIdentity, findSection, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { prepareApplication } from "../tools/build/inputs.ts";
import { demoConfigPath } from "../tools/build/programs/handheld-common.ts";
import { resolveProfile } from "../tools/profile-resolver.ts";
import { buildArtifact, buildCaptureApplication, evidenceDirectory, runBuildCommand } from "./e2e/build.ts";

const root = resolve(import.meta.dir, "..");

for (const target of ["psp", "vita"] as const) {
  test(`E2E ${target} compiles a real package before invoking the native build`, async () => {
    const directory = evidenceDirectory(root, `test-${target}`);
    const commands: string[][] = [];
    mkdirSync(directory, { recursive: true });
    const artifact = await buildCaptureApplication({
      root, directory, target, config: demoConfigPath("hero"),
      variant: { id: `dev.pocket-nexus.e2e.${target}.hero`, title: "PocketJS E2E hero", output: "e2e-hero-main" },
      env: { ...process.env, POCKETJS_CAPTURE_INPUT: "0:0" },
    }, async (command, options) => {
      commands.push([...command]);
      if (command[2] === "compile") return runBuildCommand(command, options);
      // Only the cross compiler is replaced. Use the production package admission.
      expect(command[2]).toBe("build");
      const pocket = command[command.indexOf("--pocket") + 1]!;
      expect(pocket).toBe(join(directory, "application.pocket"));
      const variant = decodePocketPackage(new Uint8Array(readFileSync(pocket))).variants[0]!;
      expect(decodeIdentity(findSection(variant, POCKET_SECTION.identity)!)).toEqual({ output: "e2e-hero-main", id: `dev.pocket-nexus.e2e.${target}.hero`, title: "PocketJS E2E hero" });
      const selected = await resolveProfile({ from: root, target });
      const app = prepareApplication(selected, pocket, join(directory, "admission"));
      expect(readFileSync(app.jsPath).length).toBeGreaterThan(0);
      expect(options.env?.POCKETJS_CAPTURE_INPUT).toBe("0:0");
      expect(command.slice(command.indexOf("--") + 1)).toEqual(["--capture"]);
      const native = command[command.indexOf("--outdir") + 1]!;
      mkdirSync(native, { recursive: true });
      const output = join(native, `fixture.${target === "psp" ? "pbp" : "vpk"}`);
      writeFileSync(output, "native compiler test double");
      writeFileSync(join(native, "build-receipt.json"), JSON.stringify({ schema: "pocket-runtime-build/1", success: true, artifact: output }));
    });
    expect(commands.map((command) => command[2])).toEqual(["compile", "build"]);
    expect(readFileSync(artifact, "utf8")).toBe("native compiler test double");
  }, 120_000);
}

test("E2E compile failure and signaled command stop before any native build", async () => {
  const directory = evidenceDirectory(root, "test-failure");
  let calls = 0;
  await expect(buildCaptureApplication({ root, directory, target: "psp", config: "missing.ts" }, async () => {
    calls++;
    throw new Error("compiler rejected input");
  })).rejects.toThrow("compiler rejected input");
  expect(calls).toBe(1);
  await expect(runBuildCommand([process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'], { root, directory })).rejects.toThrow("SIGTERM");
  expect(JSON.parse(readFileSync(join(directory, "command.json"), "utf8")).signal).toBe("SIGTERM");
});

test("a failed native receipt cannot select a stale executable", () => {
  const directory = evidenceDirectory(root, "test-receipt");
  mkdirSync(directory, { recursive: true });
  const receipt = join(directory, "build-receipt.json");
  writeFileSync(join(directory, "old.pbp"), "old");
  writeFileSync(receipt, JSON.stringify({ schema: "pocket-runtime-build/1", success: false, artifact: join(directory, "old.pbp") }));
  expect(() => buildArtifact(receipt)).toThrow("successful native build receipt required");
});
