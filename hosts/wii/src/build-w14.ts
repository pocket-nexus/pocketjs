import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeImageEntry, encodeSpriteEntry, pack } from "../../../framework/compiler/pak.ts";
import { buildGuestBundle } from "../../../tools/native-host-build.ts";
import { resolveWiiBuildPlan, WII_DEV_TARGET_ID } from "../../../tools/wii-profile.ts";

const repository = fileURLToPath(new URL("../../..", import.meta.url));
const work = process.argv[2];
if (!work) throw new Error("usage: bun build-w14.ts <work-dir>");
mkdirSync(work, { recursive: true });

const bundle = buildGuestBundle({
  label: "W14 Wii HostOps probe",
  repository,
  target: WII_DEV_TARGET_ID,
  resolvePlan: resolveWiiBuildPlan,
  manifestPath: join(repository, "hosts/wii/src/w14-pocket.json"),
  planPath: join(repository, ".pocket/wii-dev/w14-probe.plan.json"),
  outputDirectory: join(repository, "dist/wii/w14/guest"),
});

copyFileSync(bundle.javaScript, join(work, "w14-guest.js"));
const image = encodeImageEntry({
  width: 2,
  height: 2,
  rgba: Uint8Array.of(0x12, 0x34, 0x56, 0xff, 0x78, 0x9a, 0xbc, 0xff,
    0xde, 0xf0, 0x12, 0xff, 0x34, 0x56, 0x78, 0xff),
});
const sprite = encodeSpriteEntry({
  atlasW: 2,
  atlasH: 1,
  frameCount: 2,
  cols: 2,
  frameStep: 3,
  rgba: Uint8Array.of(0x12, 0x34, 0x56, 0xff, 0x78, 0x9a, 0xbc, 0xff),
});
writeFileSync(join(work, "w14-fixture.pak"), pack([
  { key: "ui:img.probe", dtype: 0, data: image },
  { key: "ui:sprite.pulse", dtype: 0, data: sprite },
]));
console.log(`W14 guest: ${bundle.plan.target.id} ABI ${bundle.plan.target.hostAbi} -> ${bundle.javaScript}`);
