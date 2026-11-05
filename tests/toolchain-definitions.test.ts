import { describe, expect, test } from "bun:test";
import { ESPUP_VERSION, ESP_XTENSA_COMPILER, verifyEspToolchain } from "../tools/build/toolchains/esp.ts";

describe("central toolchain definitions", () => {

  test("Xtensa installation keeps its verified fork separate from the shared nightly", () => {
    const compiler = `release: ${ESP_XTENSA_COMPILER.release}\ncommit-hash: ${ESP_XTENSA_COMPILER.commit}\n`;
    expect(() => verifyEspToolchain(`espup ${ESPUP_VERSION}`, compiler)).not.toThrow();
    expect(() => verifyEspToolchain("espup 0.0.0", compiler)).toThrow("espup");
    expect(() => verifyEspToolchain(`espup ${ESPUP_VERSION}`, compiler.replace(ESP_XTENSA_COMPILER.commit, "0".repeat(40)))).toThrow("Xtensa compiler");
  });
});
