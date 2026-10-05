import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { decodePNG } from "../tools/png.ts";
import { bake, distance, GROUND, ICONS, POCKET3D_ICON } from "../tools/pocket3d-icon.ts";
import { resolveVitaPackageAssets, VITA_ICON_VPK_PATH } from "../tools/vita-package.ts";

// engine/pocket3d/icon/ holds the icon a Pocket3D game shows in a console's
// launcher. tools/pocket3d-icon.ts bakes it from site/pocket3d/mark.svg.
const ROOT = new URL("..", import.meta.url).pathname;
const DIRECTORY = ROOT + "engine/pocket3d/icon/";
const SIZES: Record<string, [number, number]> = {
  "psp/ICON0.PNG": [144, 80],
  "vita/icon0.png": [128, 128],
  "3ds/icon.png": [48, 48],
  "3ds/icon-small.png": [24, 24],
  "ios/Icon.png": [57, 57],
  "ios/Icon@2x.png": [114, 114],
};
const near = (rgba: Uint8Array, at: number, colour: readonly number[], within: number) =>
  Math.abs(rgba[at] - colour[0]) <= within && Math.abs(rgba[at + 1] - colour[1]) <= within && Math.abs(rgba[at + 2] - colour[2]) <= within;

test("each launcher's file has the size and the form that launcher reads", () => {
  expect(ICONS.map((icon) => icon.file.slice(DIRECTORY.length)).sort()).toEqual(Object.keys(SIZES).sort());
  expect(Object.values<string>(POCKET3D_ICON).sort()).toEqual(ICONS.map((icon) => icon.file).sort());
  for (const [file, [width, height]] of Object.entries(SIZES)) {
    const png = readFileSync(DIRECTORY + file);
    expect([file, png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([file, width, height]);
    // colour type 3 is a palette: the PS Vita's packager takes nothing else for the bubble
    expect([file, png[24], png[25] === 3, png[28]]).toEqual([file, 8, file.startsWith("vita/"), 0]);
    expect(png.length).toBeLessThan(8 * 1024);
  }
});

test("the committed icons are the mark as tools/pocket3d-icon.ts draws it today", async () => {
  for (const { icon, rgba } of await bake()) {
    const committed = decodePNG(readFileSync(icon.file));
    expect([committed.w, committed.h]).toEqual([icon.width, icon.height]);
    // a rasterizer on another machine may round an edge pixel differently; another drawing moves whole shapes
    const { mean, max } = distance(committed.rgba, rgba);
    expect([icon.file.slice(DIRECTORY.length), mean < 0.5, max <= 48]).toEqual([icon.file.slice(DIRECTORY.length), true, true]);
  }
});

test("every size shows the mark, centred on the title card's ground", () => {
  for (const [file, [width, height]] of Object.entries(SIZES)) {
    const { rgba } = decodePNG(readFileSync(DIRECTORY + file));
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
      expect([file, x, y, near(rgba, (y * width + x) * 4, GROUND, 0)]).toEqual([file, x, y, true]);
    }
    let left = width, right = -1, top = height, bottom = -1, pink = 0, cyan = 0, gold = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      if (near(rgba, at, [0xff, 0x5f, 0x9e], 40)) pink++;
      if (near(rgba, at, [0x3f, 0xd0, 0xe8], 40)) cyan++;
      if (near(rgba, at, [0xff, 0xd2, 0x3f], 40)) gold++;
      if (near(rgba, at, GROUND, 6)) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
    // the lens, a key and the shell survive at 24 pixels
    expect([file, pink > 0, cyan > 0, gold > 0]).toEqual([file, true, true, true]);
    expect(Math.abs((left + right + 1) / 2 - width / 2)).toBeLessThanOrEqual(1);
    expect(Math.abs((top + bottom + 1) / 2 - height / 2)).toBeLessThanOrEqual(1);
    // the mark leaves ground on every side
    expect([file, left > 0, top > 0, right < width - 1, bottom < height - 1]).toEqual([file, true, true, true, true]);
  }
});

test("the PS Vita packager takes the icon in place of the framework's and the game's", () => {
  const assets = resolveVitaPackageAssets({ icon: POCKET3D_ICON.vita });
  expect(assets.find((asset) => asset.destination === VITA_ICON_VPK_PATH)!.source).toBe(POCKET3D_ICON.vita);
  // a game's asset tree that still holds an icon loses to the explicit one
  const withTree = resolveVitaPackageAssets({ applicationAssets: ROOT + "apps/devkit/vita", icon: POCKET3D_ICON.vita });
  expect(withTree.find((asset) => asset.destination === VITA_ICON_VPK_PATH)!.source).toBe(POCKET3D_ICON.vita);
  expect(() => resolveVitaPackageAssets({ icon: DIRECTORY + "vita/missing.png" })).toThrow("Vita icon not found");
  // the XMB's 144 x 80 file is not a bubble icon
  expect(() => resolveVitaPackageAssets({ icon: POCKET3D_ICON.psp })).toThrow();
});

test("the README, the skill and the Pocket3D entry point name every file", () => {
  const readme = readFileSync(DIRECTORY + "README.md", "utf8");
  const skill = readFileSync(ROOT + "skills/pocket3d-brand/SKILL.md", "utf8");
  for (const file of Object.keys(SIZES)) {
    expect([file, readme.includes(`\`${file}\``), skill.includes(`\`${file}\``)]).toEqual([file, true, true]);
  }
  expect(skill).toMatch(/^---\nname: pocket3d-brand\ndescription: /);
  for (const [, path] of skill.matchAll(/\]\(\.\.\/\.\.\/([^)#]+)/g)) expect([path, existsSync(ROOT + path)]).toEqual([path, true]);
  for (const [, path] of readme.matchAll(/\]\(\.\.\/([^)#]+)/g)) expect([path, existsSync(ROOT + "engine/pocket3d/" + path)]).toEqual([path, true]);
  const entry = readFileSync(ROOT + "pocket3d/README.md", "utf8");
  expect(entry).toContain("(../engine/pocket3d/icon/README.md)");
  expect(entry).toContain("(../skills/pocket3d-brand/SKILL.md)");
  // the commands the README gives exist
  expect(JSON.parse(readFileSync(ROOT + "package.json", "utf8")).scripts["pocket3d:app-icon:check"]).toBe("bun tools/pocket3d-icon.ts --check");
});
