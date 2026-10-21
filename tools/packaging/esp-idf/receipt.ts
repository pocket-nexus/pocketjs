import { idfProgramCrateRoots } from "./vendor.ts";
import { POCKET_BINDING_GENERATION } from "../../../contracts/spec/binding-generation.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const NATIVE_COMPONENTS = [
  { component: "pocket_runtime", crate: "runtime", archive: "libpocket_idf_runtime.a" },
] as const;
export type NativeComponent = typeof NATIVE_COMPONENTS[number];
export const RUST_TARGETS = { esp32p4: "riscv32imafc-unknown-none-elf", esp32s3: "xtensa-esp32s3-none-elf", esp32c3: "riscv32imc-unknown-none-elf", esp32c6: "riscv32imac-unknown-none-elf" } as const;
export type IdfTarget = keyof typeof RUST_TARGETS;
export const NATIVE_POLICY = { profile: "release", defaultFeatures: false, locked: true,
codegenUnits: 16, lto: false, optLevel: 3, panic: "abort", preparationVersion: 1,
  rustArchiveLayout: "single-runtime", hostAbi: POCKET_BINDING_GENERATION } as const;
export const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export interface NativeReceipt {
  schemaVersion: 2;
  component: string;
  target: IdfTarget;
  rustTarget: string;
  compiler: string;
  archiver: { version: string; executableSha256: string } | null;
  sourceSha256: string;
  archiveSha256: string;
  archiveBytes: number;
  policy: typeof NATIVE_POLICY;
}

export async function nativeSourceFiles(root: string, spec: NativeComponent): Promise<string[]> {
  const roots = [...idfProgramCrateRoots(root, spec.crate).map(path => relative(root, path).replaceAll("\\", "/")),
    `platforms/esp-idf/${spec.component}/src`, `platforms/esp-idf/${spec.component}/include`,
    "platforms/esp-idf/pocket_render_esp_ppa/src", "platforms/esp-idf/pocket_render_esp_ppa/include",
    "engine/guest-quickjs/src", "engine/guest-quickjs/include", "platforms/esp-idf/pocket_guest_quickjs"];
  const files = new Set([
    "tools/packaging/esp-idf/native.ts", "tools/packaging/esp-idf/stage.ts", "tools/packaging/esp-idf/vendor.ts",
    "contracts/generated/pocket_drivers.h", "contracts/generated/pocket_runtime.h", "contracts/generated/pocket_spec.h",
    "platforms/esp-idf/pocket_render_esp_ppa/CMakeLists.txt", "tools/packaging/esp-idf/receipt.ts", "tools/build/toolchains/esp-idf/compiler-pins.json",
    "tools/packaging/esp-idf/contracts.ts", `platforms/esp-idf/${spec.component}/CMakeLists.txt`,
    "platforms/esp-idf/pocket_runtime/native_archive.cmake",
    "platforms/esp-idf/pocket_runtime/prepare_archive.cmake", "platforms/esp-idf/pocket_runtime/tools/native_sources.py",
    "platforms/esp-idf/pocket_guest_quickjs/CMakeLists.txt",
    "platforms/esp-idf/pocket_guest_quickjs/tools/prepare_quickjs.py",
    "contracts/spec/profile.ts", "contracts/spec/binding-generation.ts",
  ]);
  for (const path of ["Cargo.toml", "Cargo.lock", "engine/Cargo.toml", "engine/Cargo.lock"])
    if (existsSync(join(root, path))) files.add(path);
  for (const path of roots) {
    if (!existsSync(join(root, path))) throw new Error(`missing native source root: ${path}`);
    for await (const file of new Bun.Glob("**/*").scan({ cwd: join(root, path), dot: true })) {
      if (file.split("/").some(part => part === "target" || part.startsWith("target-") || [".git", "__pycache__", "node_modules", ".pocket-build", "dist"].includes(part))) continue;
      files.add(`${path}/${file}`);
    }
  }
  return [...files].sort();
}

export async function nativeSourceDigest(root: string, spec: NativeComponent): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(NATIVE_POLICY)).update("\0");
  for (const file of await nativeSourceFiles(root, spec)) {
    const bytes = readFileSync(join(root, file));
    hash.update(file).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return hash.digest("hex");
}

export function verifyNativeCompiler(root: string, target: IdfTarget, compiler: string): void {
  const expected = JSON.parse(readFileSync(join(root, "tools/build/toolchains/esp-idf/compiler-pins.json"), "utf8"))[target];
  if (typeof compiler !== "string" || !expected ||
      !compiler.split("\n").includes(`release: ${expected.release}`) ||
      !compiler.split("\n").includes(`commit-hash: ${expected.commit}`)) {
    throw new Error(`native compiler differs from the pinned ${target} release toolchain`);
  }
}

export async function verifyNativeReceipt(root: string, spec: NativeComponent, target: IdfTarget,
                                         directory = join(root, "platforms/esp-idf", spec.component, "lib", target)): Promise<NativeReceipt> {
  const receipt = JSON.parse(readFileSync(join(directory, "build-receipt.json"), "utf8")) as NativeReceipt;
  if (receipt.schemaVersion !== 2 || receipt.component !== spec.component || receipt.target !== target ||
      receipt.rustTarget !== RUST_TARGETS[target] || JSON.stringify(receipt.policy) !== JSON.stringify(NATIVE_POLICY)) {
    throw new Error(`native receipt target/component/build policy mismatch: ${spec.component}/${target}`);
  }
  verifyNativeCompiler(root, target, receipt.compiler);
  if (target === "esp32p4" && (!receipt.archiver || typeof receipt.archiver.version !== "string" ||
      !receipt.archiver.version || !/^[0-9a-f]{64}$/.test(receipt.archiver.executableSha256)))
    throw new Error("native receipt has no archive preparation tool identity");
  if (target !== "esp32p4" && receipt.archiver !== null) throw new Error("unexpected archive preparation for a soft-float target");
  const archive = readFileSync(join(directory, spec.archive));
  if (archive.length !== receipt.archiveBytes || sha256(archive) !== receipt.archiveSha256)
    throw new Error(`native archive digest/size mismatch: ${spec.component}/${target}`);
  let source: string;
  try { source = await nativeSourceDigest(root, spec); }
  catch (error) { throw new Error(`native sources/build rules changed: rebuild ${spec.component}/${target}: ${error}`); }
  if (receipt.sourceSha256 !== source)
    throw new Error(`native sources/build rules changed: rebuild ${spec.component}/${target}`);
  return receipt;
}

if (import.meta.main) {
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  for (const spec of NATIVE_COMPONENTS) for (const target of Object.keys(RUST_TARGETS) as IdfTarget[]) {
    await verifyNativeReceipt(root, spec, target);
    console.log(`verified ${spec.component}/${target}`);
  }
}
