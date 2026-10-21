import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DRIVER_ABI_CALLBACKS, DRIVER_ABI_STRUCTS } from "../contracts/spec/driver-abi.ts";
import { INPUT_CLASSES, INPUT_ABI_CONSTANTS, LEGACY_FRAME_ARGUMENTS, inputClassesForCapabilities } from "../contracts/spec/input.ts";
import { HOST_ABI_FUNCTIONS, RUNTIME_ABI_STRUCTS } from "../contracts/spec/runtime-abi.ts";
import { BTN, DRAW_LIST_VERSION } from "../contracts/spec/spec.ts";
import { MOTION_VALUES } from "../contracts/spec/motion.ts";
import { abiLayout, generatedDriverContracts } from "../tools/driver-contracts.ts";

const root = resolve(import.meta.dir, "..");
const records = [...DRIVER_ABI_STRUCTS, ...RUNTIME_ABI_STRUCTS];
const compiler = Bun.which("clang");
const rustc = Bun.which("rustc");
const runDir = resolve(root, `.pocket-build/validation/driver-contracts/${Date.now()}-${process.pid}`);
function write(name: string, contents: string): string {
  mkdirSync(runDir, { recursive: true });
  const path = resolve(runDir, name);
  writeFileSync(path, contents);
  return path;
}
function run(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`${command.join(" ")} (exit=${result.exitCode}, signal=${result.signalCode})\n${result.stdout.toString()}${result.stderr.toString()}`);
  return result.stdout.toString();
}

describe("candidate driver and runtime contract generation", () => {
  test("all generated artifacts are byte-exact and deterministic", () => {
    const first = generatedDriverContracts();
    expect([...first]).toEqual([...generatedDriverContracts()]);
    for (const [path, contents] of first) expect(readFileSync(resolve(root, path), "utf8")).toBe(contents);
  });

  test("input classes preserve existing button and motion vocabulary", () => {
    expect(Object.keys(INPUT_CLASSES)).toEqual(["buttons", "axis.absolute", "axis.relative", "pointer", "contact", "text", "motion"]);
    expect(new Set(Object.values(INPUT_CLASSES).map(value => value.bit)).size).toBe(7);
    for (const [name, value] of Object.entries(BTN)) expect(INPUT_ABI_CONSTANTS[`POCKET_BUTTON_${name}`]).toBe(value);
    expect(inputClassesForCapabilities(["input.buttons", "input.touch.auxiliary", "input.ime"])).toBe(INPUT_CLASSES.buttons.bit | INPUT_CLASSES.contact.bit | INPUT_CLASSES.text.bit);
    expect(inputClassesForCapabilities(["input.cursor", "audio.pcm"])).toBe(0);
    expect(LEGACY_FRAME_ARGUMENTS).toEqual(["buttons", "analog", "touches", "hits", "touchSurfaces", "rightAnalog", "axisDeltas", "motion"]);
    const motion = DRIVER_ABI_STRUCTS.find(record => record.name === "PocketMotionState")!;
    expect(motion.fields.length - 2).toBe(Object.keys(MOTION_VALUES).length);
  });

  test("vtable prefixes are optional and zero-copy has a distinct callback", () => {
    for (const record of records) expect(record.fields[0]).toEqual({ name: "struct_size", type: "usize" });
    for (const record of records.filter(record => record.name.endsWith("V1"))) {
      for (const field of record.fields.slice(1)) expect(field.type.startsWith("Option<")).toBe(true);
    }
    expect(DRIVER_ABI_CALLBACKS.find(cb => cb.name === "PocketRenderFn")).toBeDefined();
    expect(DRIVER_ABI_CALLBACKS.find(cb => cb.name === "PocketRenderZeroCopyFn")).toBeDefined();
    expect(HOST_ABI_FUNCTIONS.map(fn => fn.name)).toEqual(["pocket_host_alloc", "pocket_host_realloc", "pocket_host_free", "pocket_host_panic", "pocket_host_log", "pocket_host_boot_stage"]);
  });

  test("32-bit layouts respect target scalar alignment rather than pointer width", () => {
    const x86 = { pointerSize: 4, pointerAlign: 4, u64Align: 4, i64Align: 4, f64Align: 4 };
    const arm = { pointerSize: 4, pointerAlign: 4, u64Align: 8, i64Align: 8, f64Align: 8 };
    expect(abiLayout("PocketTarget", x86)).toEqual({ size: 28, align: 4, offsets: [0, 4, 8, 12, 16, 20] });
    expect(abiLayout("PocketTarget", arm)).toEqual({ size: 32, align: 8, offsets: [0, 4, 8, 12, 16, 24] });
    expect(abiLayout("PocketResult", x86).align).toBe(4);
    expect(abiLayout("PocketResult", arm).align).toBe(8);
  });

  test.skipIf(!compiler || !rustc)("C11 and Rust compilers agree on every record size, alignment and field offset", () => {
    const c = write("layouts.c", `#include <stdio.h>\n#include "pocket_runtime.h"\nint main(void) {\n${records.map(record => `  printf("${record.name} %zu %zu${record.fields.map(() => " %zu").join("")}\\n", sizeof(${record.cName}), _Alignof(${record.cName}), ${record.fields.map(field => `offsetof(${record.cName}, ${field.name})`).join(", ")});`).join("\n")}\nreturn 0;\n}\n`);
    const rust = write("layouts.rs", `#[path = ${JSON.stringify(resolve(root, "engine/drivers/src/abi.rs"))}]\n#[allow(dead_code)]\nmod abi;\nuse abi::*;\nfn main() {\n${records.map(record => `  println!("${record.name} {} {}${record.fields.map(() => " {}").join("")}", core::mem::size_of::<${record.name}>(), core::mem::align_of::<${record.name}>(), ${record.fields.map(field => `core::mem::offset_of!(${record.name}, ${field.name})`).join(", ")});`).join("\n")}\n}\n`);
    const cBinary = resolve(runDir, "c-layouts");
    const rustBinary = resolve(runDir, "rust-layouts");
    run([compiler!, "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", resolve(root, "contracts/generated"), c, "-o", cBinary]);
    run([rustc!, "--edition=2021", "-Dwarnings", rust, "-o", rustBinary]);
    const cOutput = run([cBinary]);
    expect(cOutput.trim().split("\n")).toHaveLength(records.length);
    expect(run([rustBinary])).toBe(cOutput);
    write("host-layouts.txt", cOutput);
  }, 60_000);

  test.skipIf(!compiler)("headers compile as C11 and C++11 on 64-bit, i686, ARM and wasm targets", () => {
    const source = write("cross-layouts.c", '#include "pocket_spec.h"\n#include "pocket_drivers.h"\n#include "pocket_runtime.h"\n');
    const include = ["-I", resolve(root, "contracts/generated")];
    for (const language of ["c", "c++"]) {
      for (const target of [undefined, "i386-unknown-none-elf", "armv7-none-eabi", "wasm32-unknown-unknown"]) {
        run([compiler!, "-x", language, `-std=${language === "c" ? "c11" : "c++11"}`, "-ffreestanding", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", ...include, ...(target ? ["-target", target] : []), source]);
      }
    }
  }, 60_000);

  test.skipIf(!rustc)("generated Rust ABI compiles without std", () => {
    const source = write("nostd.rs", `#![no_std]\n#[path = ${JSON.stringify(resolve(root, "engine/drivers/src/abi.rs"))}]\n#[allow(dead_code)]\nmod abi;\nconst _: () = assert!(abi::POCKET_DRAW_LIST_VERSION == ${DRAW_LIST_VERSION});\n`);
    run([rustc!, "--edition=2021", "--crate-type=lib", "--emit=metadata", "-Dwarnings", source, "-o", resolve(runDir, "nostd.rmeta")]);
  }, 60_000);
});
