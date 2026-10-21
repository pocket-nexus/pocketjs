import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareApplication } from "../tools/build/inputs.ts";
import { resolveProfile } from "../tools/profile-resolver.ts";
import { demoManifestFor } from "../tools/demo-identity.ts";
import { buildArtifact, buildCaptureApplication, buildCaptureLauncher, evidenceDirectory, runBuildCommand } from "./e2e/build.ts";

const root = resolve(import.meta.dir, "..");

for (const target of ["psp", "vita"] as const) {
  test(`E2E ${target} compiles a real package before invoking the native build`, async () => {
    const directory = evidenceDirectory(root, `test-${target}`);
    const commands: string[][] = [];
    mkdirSync(directory, { recursive: true });
    const manifest = demoManifestFor(`${root}/`, "hero") as Record<string, any>;
    manifest.id = `dev.pocket-nexus.e2e.${target}.hero`;
    manifest.name = "pocketjs-e2e-hero";
    manifest.title = "PocketJS E2E hero";
    manifest.app.output = "e2e-hero-main";
    const manifestPath = join(directory, "hero.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const artifact = await buildCaptureApplication({
      root, directory, target, manifest: manifestPath,
      env: { ...process.env, POCKETJS_CAPTURE_INPUT: "0:0" },
    }, async (command, options) => {
      commands.push([...command]);
      if (command[2] === "compile") return runBuildCommand(command, options);
      // Only the cross compiler is replaced. Use the production package admission.
      expect(command[2]).toBe("build");
      expect(command).not.toContain("--manifest");
      const pocket = command[command.indexOf("--pocket") + 1]!;
      expect(pocket).toBe(join(directory, "application.pocket"));
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
  await expect(buildCaptureApplication({ root, directory, target: "psp", manifest: "missing.json" }, async () => {
    calls++;
    throw new Error("compiler rejected input");
  })).rejects.toThrow("compiler rejected input");
  expect(calls).toBe(1);
  await expect(runBuildCommand([process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")'], { root, directory })).rejects.toThrow("SIGTERM");
  expect(JSON.parse(readFileSync(join(directory, "command.json"), "utf8")).signal).toBe("SIGTERM");
});

test("launcher E2E delegates registry compilation and snapshots the receipt artifact", async () => {
  for (const target of ["psp", "vita"] as const) {
    const fixture = evidenceDirectory(root, `test-launcher-${target}`);
    const directory = join(fixture, "evidence");
    const artifact = await buildCaptureLauncher({ root: fixture, directory, target }, async (command) => {
      expect(command.slice(2)).toEqual(["build", "--target", target, "--", "--capture"]);
      expect(command[1]).toBe(join(fixture, "tools/launcher.ts"));
      const output = join(fixture, target === "psp" ? "dist" : "dist/launcher/vita");
      mkdirSync(join(output, "native"), { recursive: true });
      const native = join(output, "native/capture.bin");
      writeFileSync(native, "artifact from current recipe");
      writeFileSync(join(output, "native/build-receipt.json"), JSON.stringify({ schema: "pocket-runtime-build/1", success: true, artifact: native }));
      writeFileSync(join(output, "launcher-registry.json"), '{"apps":[]}');
    });
    expect(artifact).toBe(join(directory, "capture.bin"));
    expect(readFileSync(artifact, "utf8")).toBe("artifact from current recipe");
    expect(JSON.parse(readFileSync(join(directory, "launcher-registry.json"), "utf8"))).toEqual({ apps: [] });
  }
});

test("a failed native receipt cannot select a stale executable", () => {
  const directory = evidenceDirectory(root, "test-receipt");
  mkdirSync(directory, { recursive: true });
  const receipt = join(directory, "build-receipt.json");
  writeFileSync(join(directory, "old.pbp"), "old");
  writeFileSync(receipt, JSON.stringify({ schema: "pocket-runtime-build/1", success: false, artifact: join(directory, "old.pbp") }));
  expect(() => buildArtifact(receipt)).toThrow("successful native build receipt required");
});
