import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DRIVER_ABI_STRUCTS } from "../contracts/spec/driver-abi.ts";
import { INPUT_CLASSES, inputClassesForCapabilities } from "../contracts/spec/input.ts";
import { RUNTIME_ABI_STRUCTS } from "../contracts/spec/runtime-abi.ts";
import { DRAW_LIST_VERSION } from "../contracts/spec/spec.ts";
import { abiLayout } from "../tools/driver-contracts.ts";

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

  test("capabilities select the supported input class mask", () => {
    expect(inputClassesForCapabilities(["input.buttons", "input.touch.auxiliary", "input.ime"])).toBe(INPUT_CLASSES.buttons.bit | INPUT_CLASSES.contact.bit | INPUT_CLASSES.text.bit);
    expect(inputClassesForCapabilities(["input.cursor", "audio.pcm"])).toBe(0);
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

  test.skipIf(!compiler)("headers compile as C99/C11 and C++98/C++11 on 64-bit, i686, ARM and wasm targets", () => {
    const source = write("cross-layouts.c", '#include "pocket_spec.h"\n#include "pocket_drivers.h"\n#include "pocket_runtime.h"\n');
    const include = ["-I", resolve(root, "contracts/generated")];
    for (const [language, standard] of [["c", "gnu99"], ["c", "c11"], ["c++", "c++98"], ["c++", "c++11"]]) {
      for (const target of [undefined, "i386-unknown-none-elf", "armv7-none-eabi", "wasm32-unknown-unknown"]) {
        run([compiler!, "-x", language, `-std=${standard}`, "-ffreestanding", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", ...include, ...(target ? ["-target", target] : []), source]);
      }
    }
  }, 60_000);

  test.skipIf(!rustc)("generated Rust ABI compiles without std", () => {
    const source = write("nostd.rs", `#![no_std]\n#[path = ${JSON.stringify(resolve(root, "engine/drivers/src/abi.rs"))}]\n#[allow(dead_code)]\nmod abi;\nconst _: () = assert!(abi::POCKET_DRAW_LIST_VERSION == ${DRAW_LIST_VERSION});\n`);
    run([rustc!, "--edition=2021", "--crate-type=lib", "--emit=metadata", "-Dwarnings", source, "-o", resolve(runDir, "nostd.rmeta")]);
  }, 60_000);
});
