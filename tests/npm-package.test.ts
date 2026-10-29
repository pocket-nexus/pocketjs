import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function packArchive(cwd: string, destination: string): string {
  const result = Bun.spawnSync({
    cmd: ["npm", "pack", "--json", "--pack-destination", destination],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const parsed = JSON.parse(result.stdout.toString()) as unknown;
  const report = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]
  ) as { filename: string } | undefined;
  expect(report?.filename).toBeDefined();
  return join(destination, report!.filename);
}

describe("published npm artifacts", () => {

  test("extracted framework resolves profiles and generic recipes without Cargo sources", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pocketjs-npm-consumer-"));
    try {
      const archive = packArchive(root, scratch);
      const extract = Bun.spawnSync(["tar", "-xf", archive, "-C", scratch], { stdout: "pipe", stderr: "pipe" });
      expect(extract.success, extract.stderr.toString()).toBe(true);
      const directory = join(scratch, "package");
      symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
      writeFileSync(join(directory, "consumer.ts"), `
import { parsePocketProfile } from "@pocketjs/framework/profile";
import psp from "@pocketjs/framework/hosts/psp" with { type: "json" };
import { resolveRuntimeProgram } from "./tools/build/programs.ts";
import { sdkCommand } from "./tools/sdk.ts";
const external = parsePocketProfile({ ...psp, id: "external-product-with-a-long-id" });
if (external.id !== "external-product-with-a-long-id") throw Error("host contract not parsed");
const selected = await resolveRuntimeProgram({ from: ${JSON.stringify(scratch)}, target: "psp", generic: true });
if (!selected.config.value.build.genericRuntime.repack) throw Error("missing repack adapter");
if (await sdkCommand(["export", "--cargo", "--out", ${JSON.stringify(join(scratch, "program"))}])) throw Error("template failed");
console.log("npm consumer passed");
`);
      const consumer = Bun.spawnSync([process.execPath, "consumer.ts"], { cwd: directory, stdout: "pipe", stderr: "pipe" });
      expect(consumer.success, consumer.stderr.toString()).toBe(true);
      expect(consumer.stdout.toString()).toContain("npm consumer passed");
      expect(readFileSync(join(scratch, "program/Cargo.toml"), "utf8")).toContain('version = "0.1.0", default-features = false');
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }, 60_000);
});
