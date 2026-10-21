import { resolve } from "node:path";
import { exportSdk, parseSdkExport } from "./archive.ts";
import { ESP_TOOLCHAIN_NAME, verifyEspToolchain } from "../build/toolchains/esp.ts";
import { BUILD_STD_NIGHTLY, STABLE_RUST_TOOLCHAIN } from "../build/toolchains/rust.ts";

/** Each row is one target × feature set; the C SDK contains no Rust drivers. */
export const SDK_MATRIX = [
  ...["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "aarch64-apple-darwin",
    "thumbv6m-none-eabi", "thumbv7m-none-eabi", "thumbv7em-none-eabi", "thumbv7em-none-eabihf",
    "thumbv8m.main-none-eabi", "thumbv8m.main-none-eabihf", "riscv64gc-unknown-none-elf",
    "riscv32imc-unknown-none-elf", "riscv32imac-unknown-none-elf", "riscv32imafc-unknown-none-elf"]
    .map(triple => ({ triple, toolchain: STABLE_RUST_TOOLCHAIN, features: [] as string[], cargoArgs: [] as string[] })),
  ...["armv6k-nintendo-3ds", "thumbv4t-none-eabi"].map(triple => ({ triple, toolchain: BUILD_STD_NIGHTLY,
    features: [] as string[], cargoArgs: ["-Zbuild-std=core,alloc", "-Zbuild-std-features=compiler-builtins-mem"] })),
  { triple: "xtensa-esp32s3-none-elf", toolchain: ESP_TOOLCHAIN_NAME, features: [] as string[],
    cargoArgs: ["-Zbuild-std=core,alloc", "-Zbuild-std-features=compiler-builtins-mem"] },
] as const;
export async function buildSdkMatrixRow(triple: string, output: string, extra: string[] = []): Promise<void> {
  const row = SDK_MATRIX.find(row => row.triple === triple);
  if (!row) throw new Error("target is absent from SDK release matrix: " + triple);
  if (row.toolchain === ESP_TOOLCHAIN_NAME) {
    const output = (command: string[]) => {
      const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
      if (!result.success) throw new Error("Xtensa toolchain inspection failed: " + result.stderr);
      return result.stdout.toString();
    };
    verifyEspToolchain(output(["espup", "--version"]), output(["rustc", "+" + ESP_TOOLCHAIN_NAME, "-Vv"]));
  }
  const options = parseSdkExport(["--triple", triple, "--out", resolve(output), "--toolchain", row.toolchain,
    ...row.cargoArgs.map(flag => "--cargo-arg=" + flag), ...extra]);
  await exportSdk(options);
}
if (import.meta.main) {
  const [triple, output, ...extra] = Bun.argv.slice(2);
  if (triple === "--list") console.log(JSON.stringify(SDK_MATRIX));
  else {
    if (!triple || !output) throw new Error("usage: matrix.ts <triple> <output-directory> [SDK build options]");
    await buildSdkMatrixRow(triple, output, extra);
  }
}
