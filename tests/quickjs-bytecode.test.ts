import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DESKTOP_QUICKJS_ENGINE_ABI,
  PSP_QUICKJS_ENGINE_ABI,
  QUICKJS_BYTECODE_FILENAME,
  canonicalEngineAbiDescriptor,
  engineAbiDigest,
  quickJsEngineAbiForTarget,
} from "../contracts/spec/quickjs-bytecode.ts";
import { decodeBytecodeEnvelope } from "../contracts/spec/pocket-package.ts";
import {
  compileQuickJsBytecode,
  findCachedQuickJsCompilerSource,
  type QuickJsCompilerSource,
} from "../tools/quickjs-bytecode.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const TEST_BUILD_ROOT = join(ROOT, ".pocket-build/quickjs-bytecode-tests");

test("QuickJS engine ABI descriptors pin serialization and target identity", () => {
  expect(QUICKJS_BYTECODE_FILENAME).toBe("app.js");
  expect(PSP_QUICKJS_ENGINE_ABI.descriptor.engine).toMatchObject({
    revision: "ba5bdd0dc013518768e76cd9e05cd30ed53dd35b",
    version: "2026-06-04",
    bytecodeVersion: 5,
  });
  expect(PSP_QUICKJS_ENGINE_ABI.descriptor.serialization).toEqual({
    filename: "app.js",
    evalType: "global",
    strict: false,
    evalFlags: ["JS_EVAL_TYPE_GLOBAL", "JS_EVAL_FLAG_COMPILE_ONLY"],
    writeFlags: ["JS_WRITE_OBJ_BYTECODE"],
  });
  expect(DESKTOP_QUICKJS_ENGINE_ABI.descriptor.binding).toMatchObject({
    version: "0.12.2",
    checksum: "a13ac243b86a74120814ef7e9e30ad5a2c1199b7b9963b1cf7c84e4cdc1cad99",
    revision: "635f9322ccc875e3f9851e7f75ec538cf3274fd5",
  });
  expect(DESKTOP_QUICKJS_ENGINE_ABI.descriptor.engine).toMatchObject({
    revision: "fd0a0210b7be00957751871e7e01b8291268fc29",
    version: "0.15.1",
    bytecodeVersion: 26,
  });
  expect(DESKTOP_QUICKJS_ENGINE_ABI.descriptor.serialization.strict).toBe(true);
  expect(DESKTOP_QUICKJS_ENGINE_ABI.descriptor.serialization.evalFlags).toEqual([
    "JS_EVAL_TYPE_GLOBAL",
    "JS_EVAL_FLAG_STRICT",
    "JS_EVAL_FLAG_COMPILE_ONLY",
  ]);
  for (const abi of [PSP_QUICKJS_ENGINE_ABI, DESKTOP_QUICKJS_ENGINE_ABI]) {
    expect(abi.canonicalDescriptor).toBe(canonicalEngineAbiDescriptor(abi.descriptor));
    expect(abi.sha256).toBe(engineAbiDigest(abi.descriptor));
  }
  expect(quickJsEngineAbiForTarget("psp")).toBe(PSP_QUICKJS_ENGINE_ABI);
  expect(quickJsEngineAbiForTarget("macos-app")).toBe(DESKTOP_QUICKJS_ENGINE_ABI);
  expect(quickJsEngineAbiForTarget("linux-app")).toBe(DESKTOP_QUICKJS_ENGINE_ABI);
  expect(quickJsEngineAbiForTarget("vita")).toBeUndefined();
});

test("engine ABI pins match the native host dependency locks", () => {
  const pspLock = readFileSync(join(ROOT, "hosts/psp/Cargo.lock"), "utf8");
  const pspToolchain = JSON.parse(
    readFileSync(join(ROOT, "tools/cli/psp-toolchain.json"), "utf8"),
  ) as { quickJsRs: { repository: string; rev: string } };
  expect(pspLock).toContain(`name = "libquickjs-sys"\nversion = "${PSP_QUICKJS_ENGINE_ABI.descriptor.binding.version}"`);
  expect(pspLock).toContain(`rev=${PSP_QUICKJS_ENGINE_ABI.descriptor.engine.revision}`);
  expect(pspToolchain.quickJsRs).toEqual({
    repository: PSP_QUICKJS_ENGINE_ABI.descriptor.engine.repository,
    rev: PSP_QUICKJS_ENGINE_ABI.descriptor.engine.revision,
  });

  const desktopLock = readFileSync(join(ROOT, "hosts/desktop/Cargo.lock"), "utf8");
  const desktopPackage = desktopLock
    .split("[[package]]")
    .find((entry) => entry.includes('name = "rquickjs-sys"'));
  expect(desktopPackage).toBeDefined();
  expect(desktopPackage).toContain(`version = "${DESKTOP_QUICKJS_ENGINE_ABI.descriptor.binding.version}"`);
  expect(desktopPackage).toContain(`checksum = "${DESKTOP_QUICKJS_ENGINE_ABI.descriptor.binding.checksum}"`);
});

test("compiler orchestration is deterministic, ABI-bound, and host-native", () => {
  mkdirSync(TEST_BUILD_ROOT, { recursive: true });
  const temporary = mkdtempSync(join(TEST_BUILD_ROOT, "orchestration-"));
  try {
    const source = join(temporary, "source");
    const cc = join(temporary, "fake-cc.mjs");
    const compilerLog = join(temporary, "cc.jsonl");
    mkdirSync(source);
    writeFileSync(cc, `#!/usr/bin/env bun
import { appendFileSync, chmodSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.POCKET_QJSC_TEST_CC_LOG, JSON.stringify(args) + "\\n");
const output = args[args.indexOf("-o") + 1];
writeFileSync(output, ${JSON.stringify(`#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const [input, output, mode] = process.argv.slice(2);
const source = readFileSync(input);
writeFileSync(output, Buffer.concat([Buffer.from([mode === "strict" ? 1 : 0]), source]));
`)});
chmodSync(output, 0o755);
`);
    chmodSync(cc, 0o755);
    const env = {
      ...process.env,
      CC: cc,
      POCKET_QJSC_TEST_CC_LOG: compilerLog,
    };
    const compilerSource = (abi: QuickJsCompilerSource["abi"]): QuickJsCompilerSource => ({
      abi,
      root: source,
      source,
    });
    const javaScript = new TextEncoder().encode("globalThis.answer = 42;\n");
    const psp = compileQuickJsBytecode("psp", javaScript, {
      buildDirectory: join(temporary, "psp-build"),
      compilerSource: compilerSource(PSP_QUICKJS_ENGINE_ABI),
      env,
    });
    const pspAgain = compileQuickJsBytecode("psp", javaScript, {
      buildDirectory: join(temporary, "psp-build"),
      compilerSource: compilerSource(PSP_QUICKJS_ENGINE_ABI),
      env,
    });
    const desktop = compileQuickJsBytecode("linux-app", javaScript, {
      buildDirectory: join(temporary, "desktop-build"),
      compilerSource: compilerSource(DESKTOP_QUICKJS_ENGINE_ABI),
      env,
    });

    expect(psp.bytecode[0]).toBe(0); // sloppy
    expect(desktop.bytecode[0]).toBe(1); // strict
    expect(psp.section).toEqual(pspAgain.section);
    expect(decodeBytecodeEnvelope(psp.section)).toEqual({
      engineAbi: PSP_QUICKJS_ENGINE_ABI.sha256,
      bytecode: psp.bytecode,
    });
    expect(decodeBytecodeEnvelope(desktop.section).engineAbi)
      .toBe(DESKTOP_QUICKJS_ENGINE_ABI.sha256);

    const invocations = readFileSync(compilerLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(invocations).toHaveLength(2); // cached PSP compiler is built once
    expect(invocations[0]).toContain("-funsigned-char");
    expect(invocations.flat()).not.toContain("-D__PSP__");
    expect(invocations.flat()).not.toContain("-D__psp__");
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

const cachedPspSource = findCachedQuickJsCompilerSource("psp");
test.skipIf(!cachedPspSource)("pinned PSP QuickJS produces stable BC v5 bytecode", () => {
  const source = new TextEncoder().encode("globalThis.answer = 6 * 7;\n");
  const buildDirectory = new URL("../.pocket-build/quickjs-bytecode", import.meta.url).pathname;
  const first = compileQuickJsBytecode("psp", source, {
    buildDirectory,
    compilerSource: cachedPspSource!,
  });
  const second = compileQuickJsBytecode("psp", source, {
    buildDirectory,
    compilerSource: cachedPspSource!,
  });
  expect(first.bytecode[0]).toBe(5);
  expect(first.section).toEqual(second.section);
  expect(decodeBytecodeEnvelope(first.section).engineAbi).toBe(PSP_QUICKJS_ENGINE_ABI.sha256);
}, 30_000);

const cachedDesktopSource = findCachedQuickJsCompilerSource("linux-app");
test.skipIf(!cachedDesktopSource)("pinned desktop QuickJS produces stable BC v26 bytecode", () => {
  const source = new TextEncoder().encode("globalThis.answer = 6 * 7;\n");
  const buildDirectory = new URL("../.pocket-build/quickjs-bytecode", import.meta.url).pathname;
  const first = compileQuickJsBytecode("linux-app", source, {
    buildDirectory,
    compilerSource: cachedDesktopSource!,
  });
  const second = compileQuickJsBytecode("linux-app", source, {
    buildDirectory,
    compilerSource: cachedDesktopSource!,
  });
  expect(first.bytecode[0]).toBe(26);
  expect(first.section).toEqual(second.section);
  expect(decodeBytecodeEnvelope(first.section).engineAbi)
    .toBe(DESKTOP_QUICKJS_ENGINE_ABI.sha256);
}, 30_000);
