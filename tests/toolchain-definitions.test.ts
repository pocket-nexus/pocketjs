import { ESPUP_VERSION, ESP_XTENSA_COMPILER, ESP_INSTALL_COMMANDS, verifyEspToolchain } from "../tools/build/toolchains/esp.ts";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pspToolchain } from "../tools/build/toolchains/psp.ts";
import { RUST_TOOLCHAINS, BUILD_STD_NIGHTLY, STABLE_RUST_TOOLCHAIN } from "../tools/build/toolchains/rust.ts";
import { HOST_IDS } from "../tools/targets/types.ts";
import { TOOLCHAIN_SCHEMA, toolchainDigest, validateToolchain } from "../tools/targets/toolchain.ts";

const root = new URL("..", import.meta.url).pathname;

describe("central toolchain definitions", () => {
  test("PSP TypeScript definition changes the installed /2 identity when the shared compiler changes", () => {
    // Captured before the JSON-to-TypeScript move. Existing installations must
    // keep their receipt/store identity when only source locations change.
    const expected = {
      "darwin-arm64": "9fc396422a3874938f031a0caa17d29f9198587965d37efff6c1a5cf34d378f8",
      "darwin-x64": "b2a29499e27aed0ccf8c1c55844d0e604fcea7e09ebc54645a2e63c01ae147e6",
      "linux-x64": "616351b5a86b2994dc601a9820a4ddcce2eacbb6b1352e115175bd095de393fe",
      "linux-arm64": "0e3dced43a932b20e2ae1899ad99d988a4c4e6ea048a4bd602cb4d31b0647093"
};
    expect(pspToolchain.schema).toBe(TOOLCHAIN_SCHEMA);
    expect(validateToolchain(pspToolchain, "psp")).toEqual([]);
    for (const host of HOST_IDS) expect(toolchainDigest(pspToolchain, host), host).not.toBe(expected[host]);
    for (const component of pspToolchain.components) {
      if (component.kind === "rustup" || component.kind === "cargo-install") expect(component.toolchain).toBe(BUILD_STD_NIGHTLY);
    }
  });

  test("Xtensa installation keeps its verified fork separate from the shared nightly", () => {
    const compiler = `release: ${ESP_XTENSA_COMPILER.release}\ncommit-hash: ${ESP_XTENSA_COMPILER.commit}\n`;
    expect(() => verifyEspToolchain(`espup ${ESPUP_VERSION}`, compiler)).not.toThrow();
    expect(() => verifyEspToolchain("espup 0.0.0", compiler)).toThrow("espup");
    expect(() => verifyEspToolchain(`espup ${ESPUP_VERSION}`, compiler.replace(ESP_XTENSA_COMPILER.commit, "0".repeat(40)))).toThrow("Xtensa compiler");
    expect(ESP_INSTALL_COMMANDS[0]).toContain("--locked");
    expect(ESP_INSTALL_COMMANDS[1]).toContain("--toolchain-version");
  });

  test("custom target relocation preserves compiler ABI definitions", () => {
    // Target bytes affect rustc ABI and Cargo cache identity. The iPhone 4S
    // and iPod touch 4 now share their formerly identical ARMv7 definition.
    const targets = {
      "tools/build/toolchains/blackberry-qnx/armv7-qnx-eabi.json": "0fb58fa171038604d66437b697ccf7edfa5b0cf188f19e44a875171f3f175f31",
      "tools/build/toolchains/iphone2g/armv6-apple-ios.json": "04966c8446d62a5f4ab51a9f09be2828042f85efa328880f2aba61aa52bdc660",
      "tools/build/toolchains/ios/armv7-apple-ios.json": "5d96d09440bb62fe43dad2347d050d69addeff2ad5f136bc5a495e75d3beb516",
      "tools/build/toolchains/meizu-m8/armv6-wince-asm.json": "93614b7c6f61a29ae987fe2f3c3e7c17102f263e673b54d3df16a8a279b5c888",
      "tools/build/toolchains/symbian/armv6-symbian-eabi.json": "4760ee40443ce3aa27161964cf51297e894fa668482822df6ff6423f470bee30",
      "tools/build/toolchains/psp/mipsel-sony-psp.json": "82106fed3edb2b32ccee25e5c264e950ba6768d7181408a240f3e7758830e662"
};
    for (const [path, expected] of Object.entries(targets)) {
      const source = readFileSync(join(root, path));
      expect(createHash("sha256").update(source).digest("hex"), path).toBe(expected);
      expect(JSON.parse(source.toString()).arch).toBeDefined();
    }
  });

  test("the root stable override is the only program rustup override", () => {
    const data = Bun.TOML.parse(readFileSync(join(root, "rust-toolchain.toml"), "utf8")) as {toolchain: {channel: string}};
    expect(data.toolchain.channel).toBe(STABLE_RUST_TOOLCHAIN);
    for (const path of ["hosts/vita", "hosts/3ds/core", "engine/ui-cabi", "hosts/esp-idf/tests/data-smoke"]) {
      expect(existsSync(join(root, path, "rust-toolchain.toml")), path).toBe(false);
    }
    for (const pin of Object.values(RUST_TOOLCHAINS)) expect(pin).toBe(BUILD_STD_NIGHTLY);
  });
});
