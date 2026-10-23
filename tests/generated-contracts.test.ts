// Every committed generated file equals its generator's in-memory output, so
// a spec edit without `bun run gen` fails here instead of on a device.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateRust } from "../contracts/spec/gen-rust.ts";
import { generateC } from "../contracts/spec/gen-c.ts";
import { generatedDriverContracts } from "../tools/driver-contracts.ts";
import { generatedUiBindings } from "../tools/ui-bindings.ts";
import { generatedGuestWebBindings } from "../tools/guest-web-bindings.ts";
import { generatedIdfContracts } from "../tools/packaging/esp-idf/contracts.ts";
import { threeDsProfileHeader } from "../tools/3ds-contracts.ts";
import { withGeneratedExports } from "../tools/gen-exports.ts";

const root = resolve(import.meta.dir, "..");
const committed = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("generated contracts are fresh", () => {
  const outputs = new Map<string, string>([
    ["engine/spec/src/lib.rs", generateRust()],
    ["contracts/generated/pocket_spec.h", generateC()],
    ...generatedDriverContracts(),
    ...generatedUiBindings(),
    ["engine/guest-web/src/ui-descriptors.js", generatedGuestWebBindings()],
    ...generatedIdfContracts(),
    ["products/3ds/include/pocket_profile.h", threeDsProfileHeader()],
  ]);
  for (const [path, expected] of outputs) {
    test(`${path} matches its generator (run \`bun run gen\`)`, () => {
      expect(committed(path)).toBe(expected);
    });
  }
  test("package.json exports match the subpath registry (run `bun run gen`)", () => {
    const text = committed("package.json");
    expect(withGeneratedExports(text)).toBe(text);
  });
});
