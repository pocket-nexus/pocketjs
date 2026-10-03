import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  POCKET_SECTION,
  decodePocketPackage,
  encodeIdentity,
  encodePocketPackage,
  findSection,
  findVariant,
} from "../../../../contracts/spec/pocket-package.ts";
import { pack, unpack } from "../../../../framework/compiler/pak.ts";

const fixturePath = new URL("./w06a.pocket", import.meta.url);
const pak = pack([
  { key: "ui:probe", dtype: 0, data: Uint8Array.of(1, 2, 3) },
  { key: "ui:probe-long", dtype: 0, data: Uint8Array.of(4, 5, 6, 7, 8, 9, 10) },
]);
const encoded = encodePocketPackage({
  manifest: new TextEncoder().encode('{"pocket":2,"id":"dev.pocket-nexus.w06a","title":"W06a"}'),
  variants: [{
    target: "wii-dev",
    hostAbi: 7,
    sections: [
      {
        kind: POCKET_SECTION.identity,
        bytes: encodeIdentity({ output: "w06a", id: "dev.pocket-nexus.w06a", title: "W06a" }),
      },
      { kind: POCKET_SECTION.plan, bytes: new TextEncoder().encode('{"target":{"id":"wii-dev"}}') },
      { kind: POCKET_SECTION.js, bytes: new TextEncoder().encode("globalThis.frame = () => {};\0") },
      { kind: POCKET_SECTION.pak, bytes: pak },
    ],
  }],
});

if (process.argv.includes("--write")) writeFileSync(fixturePath, encoded);
const bytes = readFileSync(fixturePath);
assert.equal(Buffer.compare(bytes, encoded), 0, "committed W06a fixture must match the existing encoders");
const decoded = decodePocketPackage(bytes);
const variant = findVariant(decoded, "wii-dev");
assert.ok(variant);
const desktopPak = unpack(findSection(variant, POCKET_SECTION.pak)!);
assert.equal(variant.hostAbi, 7);
assert.deepEqual(desktopPak.map(({ key, data }) => [key, data.length]), [
  ["ui:probe", 3],
  ["ui:probe-long", 7],
]);
console.log(
  `W06A PASS target=${variant.target} abi=${variant.hostAbi} pak=${findSection(variant, POCKET_SECTION.pak)!.length} entries=${desktopPak.map(({ key, data }) => `${key}:${data.length}`).join(",")}`,
);
