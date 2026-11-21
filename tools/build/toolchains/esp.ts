import compilerPins from "./esp-idf/compiler-pins.json";
import { STABLE_RUST_TOOLCHAIN } from "./rust.ts";

// espup --version on the validated installation; the esp-1.97.0.0 upstream
// branch resolves to the exact compiler commit in compiler-pins.json.
export const ESPUP_VERSION = "0.17.1";
export const ESP_TOOLCHAIN_NAME = "esp";
export const ESP_XTENSA_RELEASE = "1.97.0.0";
export const ESP_XTENSA_COMPILER = compilerPins.esp32s3;

/** Explicit installation inputs; this declaration does not install tools. */
export const ESP_INSTALL_COMMANDS = [
  ["cargo", `+${STABLE_RUST_TOOLCHAIN}`, "install", "espup", "--version", ESPUP_VERSION, "--locked"],
  ["espup", "install", "--name", ESP_TOOLCHAIN_NAME, "--toolchain-version", ESP_XTENSA_RELEASE,
    "--stable-version", STABLE_RUST_TOOLCHAIN, "--targets", "esp32s3"],
] as const;

/** An existing installation must match both the installer and compiler pin. */
export function verifyEspToolchain(espupVersion: string, rustcVersionVerbose: string): void {
  if (espupVersion.trim() !== `espup ${ESPUP_VERSION}`) throw new Error(`expected espup ${ESPUP_VERSION}`);
  const fields = new Map(rustcVersionVerbose.split(/\r?\n/).flatMap(line => {
    const colon = line.indexOf(": ");
    return colon < 0 ? [] : [[line.slice(0, colon), line.slice(colon + 2)] as const];
  }));
  if (fields.get("release") !== ESP_XTENSA_COMPILER.release || fields.get("commit-hash") !== ESP_XTENSA_COMPILER.commit) {
    throw new Error(`expected Xtensa compiler ${ESP_XTENSA_COMPILER.release} (${ESP_XTENSA_COMPILER.commit})`);
  }
}
