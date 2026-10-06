// Every repack runs where a Cloudflare Worker runs: each target's module and
// the Studio's entry (tools/repack/index.ts) bundle for the browser with no
// Node or Bun built-in module, and the bundles name no Bun, process, require
// or file path API. The Android bundle repacks the same APK as the source.

import { describe, expect, test } from "bun:test";
import { builtinModules } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REDMI_1S_TARGET } from "../tools/redmi-1s-profile.ts";
import { ANDROID_RUNTIME_TARGETS, repackAndroid } from "../tools/repack/android.ts";
import { THREE_DS_RUNTIME_TARGET } from "../tools/repack/3ds.ts";
import { REPACK_TARGETS, repackTarget } from "../tools/repack/index.ts";
import { IPOD_RUNTIME_TARGET } from "../tools/repack/ipod.ts";
import { PSP_RUNTIME_TARGET } from "../tools/repack/psp.ts";
import { VITA_RUNTIME_TARGET } from "../tools/repack/vita.ts";
import { fixturePocket, fixtureRuntime, IDENTITY } from "./helpers/android-fixture.ts";
import { makeTestSigner } from "./helpers/apk-test-signer.ts";

const ROOT = join(import.meta.dir, "..");
const ENTRIES = ["index.ts", "psp.ts", "vita.ts", "3ds.ts", "ipod.ts", "android.ts"] as const;
const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const BUILTIN = new RegExp(`^(node:.*|bun:.*|bun|${builtinModules.map(escape).join("|")})(/.*)?$`);
/** What a Worker lacks: Bun's and Node's globals, CommonJS, and the module's own path. */
const HOST_APIS = /\bBun\.|\bprocess\.|\brequire\(|__dirname|__filename|import\.meta\.(dir|path|file|main)\b|\bDeno\./g;

async function bundle(entry: string): Promise<{ text: string; builtins: string[] }> {
  const builtins: string[] = [];
  const result = await Bun.build({
    entrypoints: [join(ROOT, "tools/repack", entry)],
    target: "browser",
    format: "esm",
    plugins: [{
      name: "node-builtins",
      setup(build) {
        build.onResolve({ filter: BUILTIN }, (args) => {
          builtins.push(`${args.path} (from ${args.importer.replace(`${ROOT}/`, "")})`);
          return { path: args.path, external: true };
        });
      },
    }],
  });
  if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"));
  return { text: await result.outputs[0]!.text(), builtins };
}

describe("every repack bundles for a Worker", () => {
  for (const entry of ENTRIES) {
    test(`tools/repack/${entry} imports no Node or Bun module and calls no host API`, async () => {
      const { text, builtins } = await bundle(entry);
      expect(builtins).toEqual([]);
      expect(text.match(HOST_APIS) ?? []).toEqual([]);
    });
  }

  test("the check sees a Node import and a Bun call", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-repack-worker-"));
    try {
      writeFileSync(join(directory, "bad.ts"), 'import { readFileSync } from "node:fs";\nexport const read = () => [readFileSync, Bun.file];\n');
      const builtins: string[] = [];
      const result = await Bun.build({
        entrypoints: [join(directory, "bad.ts")],
        target: "browser",
        plugins: [{
          name: "node-builtins",
          setup(build) {
            build.onResolve({ filter: BUILTIN }, (args) => {
              builtins.push(args.path);
              return { path: args.path, external: true };
            });
          },
        }],
      });
      expect(builtins).toEqual(["node:fs"]);
      expect((await result.outputs[0]!.text()).match(HOST_APIS)).toEqual(["Bun."]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("the bundled modules repack what the source modules repack", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-repack-worker-"));
    try {
      const load = async (entry: string) => {
        const path = join(directory, entry.replace(/\.ts$/, ".js"));
        writeFileSync(path, (await bundle(entry)).text);
        return import(path);
      };
      const index = (await load("index.ts")) as typeof import("../tools/repack/index.ts");
      const android = (await load("android.ts")) as typeof import("../tools/repack/android.ts");
      const signer = await makeTestSigner();
      const input = {
        runtime: fixtureRuntime(),
        pocket: fixturePocket(),
        identity: IDENTITY,
        signer: { privateKey: signer.privateKey, certificate: signer.certificate },
      };
      const options = { certificateSha256: signer.certificateSha256 };
      expect(await android.repackAndroid(input, options)).toEqual(await repackAndroid(input, options));
      // The Studio's row signs with the community key alone.
      await expect(index.REPACK_TARGETS.android.repack(input)).rejects.toThrow(/not the Pocket Studio community certificate/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("the Studio's table", () => {
  test("one row per Studio target, each naming its runtime, variants, file and type", () => {
    const rows = Object.fromEntries(Object.entries(REPACK_TARGETS).map(([name, row]) => [name, { ...row, repack: typeof row.repack }]));
    expect(rows).toEqual({
      psp: { repack: "function", runtime: "psp", variantTargets: [PSP_RUNTIME_TARGET], extension: ".zip", contentType: "application/zip", signed: false },
      vita: { repack: "function", runtime: "vita", variantTargets: [VITA_RUNTIME_TARGET], extension: ".vpk", contentType: "application/octet-stream", signed: false },
      "3ds": { repack: "function", runtime: "3ds", variantTargets: [THREE_DS_RUNTIME_TARGET], extension: ".3dsx", contentType: "application/octet-stream", signed: false },
      "ipod-touch": { repack: "function", runtime: "ipod", variantTargets: [IPOD_RUNTIME_TARGET], extension: ".ipa", contentType: "application/octet-stream", signed: false },
      android: {
        repack: "function",
        runtime: "android",
        variantTargets: [...ANDROID_RUNTIME_TARGETS],
        extension: ".apk",
        contentType: "application/vnd.android.package-archive",
        signed: true,
      },
    });
    expect(REPACK_TARGETS.android.variantTargets[0]).toBe(REDMI_1S_TARGET);
  });

  test("a row by Studio target or runtime name", () => {
    expect(repackTarget("ipod")).toBe(REPACK_TARGETS["ipod-touch"]);
    expect(repackTarget("ipod-touch")).toBe(REPACK_TARGETS["ipod-touch"]);
    expect(repackTarget("android")).toBe(REPACK_TARGETS.android);
    expect(repackTarget("toString")).toBeUndefined();
    expect(repackTarget("gba")).toBeUndefined();
  });
});
