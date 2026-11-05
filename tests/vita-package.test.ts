import { afterEach, describe, expect, test } from "bun:test";
import {
copyFileSync,
existsSync,
mkdirSync,
mkdtempSync,
readFileSync,
rmSync,
writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vitaTitleId } from "../framework/src/manifest/vita-package.ts";
import {
DEFAULT_VITA_ICON,
DEFAULT_VITA_PACKAGE_ASSETS,
packageVitaVpk,
resolveVitaPackageAssets,
VITA_REQUIRED_SYSTEM_ASSETS,
VITA_SYSTEM_ASSET_PATHS,
vitaPackVpkArguments,
} from "../tools/vita-package.ts";

const temporaryDirectories: string[] = [];

function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PS Vita package identity", () => {
  test("deterministically encodes a Pocket application id", () => {
    const first = vitaTitleId("dev.pocket-nexus.demo.hero");
    expect(first).toBe(vitaTitleId("dev.pocket-nexus.demo.hero"));
    expect(first).toMatch(/^[A-Z][A-Z0-9]{8}$/);
  });

  test("gives different applications different title ids", () => {
    expect(vitaTitleId("dev.pocket-nexus.demo.hero"))
      .not.toBe(vitaTitleId("dev.pocket-nexus.demo.gallery"));
  });
});

describe("PS Vita LiveArea assets", () => {

  test("application assets override matching defaults and retain every other file", () => {
    const applicationAssets = mkdtempSync(join(tmpdir(), "pocketjs-vita-app-assets-"));
    temporaryDirectories.push(applicationAssets);
    const icon = join(applicationAssets, VITA_SYSTEM_ASSET_PATHS.icon);
    mkdirSync(dirname(icon), { recursive: true });
    copyFileSync(DEFAULT_VITA_ICON, icon);
    const map = join(applicationAssets, "maps/example.p3d");
    mkdirSync(dirname(map), { recursive: true });
    writeFileSync(map, "fixture");

    const assets = resolveVitaPackageAssets({ applicationAssets });
    const byDestination = new Map(assets.map((asset) => [asset.destination, asset.source]));
    expect(byDestination.get(VITA_SYSTEM_ASSET_PATHS.icon)).toBe(icon);
    expect(byDestination.get(VITA_SYSTEM_ASSET_PATHS.background))
      .toBe(join(DEFAULT_VITA_PACKAGE_ASSETS, VITA_SYSTEM_ASSET_PATHS.background));
    expect(byDestination.get("maps/example.p3d")).toBe(map);
    expect(new Set(assets.map((asset) => asset.destination)).size).toBe(assets.length);
  });

  test("builds one stable vita-pack-vpk argument list from the resolver", () => {
    const args = vitaPackVpkArguments({
      sfo: "/tmp/app.sfo",
      eboot: "/tmp/app.self",
      output: "/tmp/app.vpk",
    });
    expect(args.slice(0, 4)).toEqual(["-s", "/tmp/app.sfo", "-b", "/tmp/app.self"]);
    expect(args.at(-1)).toBe("/tmp/app.vpk");
    for (const path of VITA_REQUIRED_SYSTEM_ASSETS) {
      expect(args.some((argument) => argument.endsWith(`=${path}`))).toBe(true);
    }
  });

  test("rejects invalid PNG compression even when its CRC is valid", () => {
    const applicationAssets = mkdtempSync(join(tmpdir(), "pocketjs-vita-invalid-ihdr-"));
    temporaryDirectories.push(applicationAssets);
    const icon = join(applicationAssets, VITA_SYSTEM_ASSET_PATHS.icon);
    mkdirSync(dirname(icon), { recursive: true });
    const png = Buffer.from(readFileSync(DEFAULT_VITA_ICON));
    png[26] = 1;
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
    writeFileSync(icon, png);
    expect(() => resolveVitaPackageAssets({ applicationAssets }))
      .toThrow("must be indexed PNG-8 and non-interlaced");
  });

  test("rejects a non-structural LiveArea template", () => {
    const applicationAssets = mkdtempSync(join(tmpdir(), "pocketjs-vita-corrupt-xml-"));
    temporaryDirectories.push(applicationAssets);
    const template = join(applicationAssets, VITA_SYSTEM_ASSET_PATHS.template);
    mkdirSync(dirname(template), { recursive: true });
    writeFileSync(
      template,
      `<livearea definitely not valid xml>\n` +
        `  <livearea-background><image>bg.png</image></livearea-background>\n` +
        `  <gate><startup-image>startup.png</startup-image></gate>\n` +
        `</livearea>\n`,
    );
    expect(() => resolveVitaPackageAssets({ applicationAssets })).toThrow();
  });

  test("rejects invalid XML declarations and duplicate attributes", () => {
    const bodies = [
      `<?xml definitely-invalid?>\n<livearea>`,
      `<livearea style="a1" style="a2">`,
    ];
    for (const [index, root] of bodies.entries()) {
      const applicationAssets = mkdtempSync(join(tmpdir(), `pocketjs-vita-invalid-xml-${index}-`));
      temporaryDirectories.push(applicationAssets);
      const template = join(applicationAssets, VITA_SYSTEM_ASSET_PATHS.template);
      mkdirSync(dirname(template), { recursive: true });
      writeFileSync(
        template,
        `${root}\n` +
          `  <livearea-background><image>bg.png</image></livearea-background>\n` +
          `  <gate><startup-image>startup.png</startup-image></gate>\n` +
          `</livearea>\n`,
      );
      expect(() => resolveVitaPackageAssets({ applicationAssets })).toThrow();
    }
  });

  test("rejects asset paths that vita-pack-vpk cannot represent", () => {
    const applicationAssets = mkdtempSync(join(tmpdir(), "pocketjs-vita-equals-"));
    temporaryDirectories.push(applicationAssets);
    writeFileSync(join(applicationAssets, "bad=name.bin"), "fixture");
    expect(() => vitaPackVpkArguments({
      sfo: "/tmp/app.sfo",
      eboot: "/tmp/app.self",
      output: "/tmp/app.vpk",
      applicationAssets,
    })).toThrow("may not contain '='");
  });

  test("keeps the previous VPK and removes staging output when packaging fails", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-vita-atomic-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "app.vpk");
    writeFileSync(output, "previous");
    await expect(packageVitaVpk({
      tool: Bun.which("false") ?? "/usr/bin/false",
      sfo: join(directory, "app.sfo"),
      eboot: join(directory, "app.self"),
      output,
    })).rejects.toThrow("vita-pack-vpk failed");
    expect(readFileSync(output, "utf8")).toBe("previous");
    expect(existsSync(`${output}.pocketjs-new`)).toBe(false);
  });
});
