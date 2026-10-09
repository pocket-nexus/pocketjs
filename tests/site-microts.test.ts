import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// site/microts/mark.svg is the one drawing of the MicroTS mark. tools/icons.ts
// copies it to public/favicon.svg and rasterizes the icon family from it; the
// site draws the favicon, and pocket.nexus inlines the same shapes.
const ROOT = new URL("..", import.meta.url).pathname;
const SITE = ROOT + "site/microts/";
const PUBLIC = SITE + "public/";
const mark = readFileSync(SITE + "mark.svg", "utf8");
const favicon = readFileSync(PUBLIC + "favicon.svg", "utf8");
const shapes = [...mark.matchAll(/<(?:rect|path) [^>]*\/>/g)].map((match) => match[0]);

test("every copy of the MicroTS mark draws the shapes of mark.svg", () => {
  // the frame, two pairs of bars, two stems and the bowl
  expect(shapes.length).toBe(6);
  expect(favicon).toBe(mark.replace(/^<!--[\s\S]*?-->\s*/, ""));
  // the nav, the footer and the home page show the favicon
  expect(readFileSync(SITE + "src/components/MicroTSMark.vue", "utf8")).toContain('<img src="/favicon.svg"');
  // pocket.nexus draws one symbol, in the Technology menu and in the row of technology
  const nexus = readFileSync(ROOT + "site/nexus/public/index.html", "utf8");
  const symbol = nexus.match(/<symbol id="mts" viewBox="0 0 100 100">(.*?)<\/symbol>/s)![1];
  for (const shape of shapes) expect(symbol).toContain(shape);
  expect(nexus.match(/<use href="#mts" width="32" height="32"\/>/g)!.length).toBe(2);
  // the previous chip with a T is gone from both sites
  for (const source of [favicon, nexus]) expect(source).not.toContain("M3.5 11h4");
});

test("the page links the icon family that tools/icons.ts rasterizes from the mark", () => {
  expect(readFileSync(ROOT + "tools/icons.ts", "utf8")).toContain("source: `${ROOT}site/microts/mark.svg`");
  const html = readFileSync(SITE + "index.html", "utf8");
  const linked = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="\/([^"?]+)/g)].map((match) => match[1]);
  expect(new Set(linked)).toEqual(new Set(["favicon.svg", "favicon.ico", "favicon-96.png", "apple-touch-icon.png", "site.webmanifest"]));
  for (const file of linked) expect([file, existsSync(PUBLIC + file)]).toEqual([file, true]);
  const manifest = JSON.parse(readFileSync(PUBLIC + "site.webmanifest", "utf8"));
  for (const icon of manifest.icons) expect([icon.src, existsSync(PUBLIC + icon.src.slice(1))]).toEqual([icon.src, true]);
  // each PNG has the size its name promises; the size lives in the IHDR chunk
  const sizes: Record<string, number> = {
    "favicon-96.png": 96,
    "apple-touch-icon.png": 180,
    "apple-touch-icon-precomposed.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
    "icon-512-maskable.png": 512,
  };
  for (const [file, size] of Object.entries(sizes)) {
    const png = readFileSync(PUBLIC + file);
    expect([file, png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([file, size, size]);
  }
});

// The playground draws each device as a picture of it from the front (lib/shells.ts): the screen where the
// picture's screen is, in the shape of the screen size it stands for, and the device's keys where they are drawn.
test("every playground device has its pictures, its screen in the preset's shape, and keys in the picture", async () => {
  const { PLAYGROUND_SHELLS, shellProfiles } = await import("../site/microts/lib/shells.ts");
  const { SHELL_SETS, DOWNLOADS } = await import("../tools/handheld-shells.ts");
  const { SCREENS } = await import("../site/microts/src/playground/screens.ts");
  const profiles = await shellProfiles();
  // The preset each shell stands for (src/playground/devices.ts), and the controls its profile names.
  const presets: Record<string, string> = { psp: "psp", gba: "gba", "3ds": "3ds", "iphone-4s": "iphone", "ipod-touch-5": "ipod-touch", "bb-classic": "bb-classic", "ipod-nano": "ipod-nano" };
  const pad = ["up", "down", "left", "right"];
  const controls: Record<string, string[]> = {
    psp: [...pad, "triangle", "circle", "cross", "square", "l", "r", "start", "select"],
    "3ds": [...pad, "triangle", "circle", "cross", "square", "l", "r", "start", "select"],
    gba: [...pad, "a", "b", "start", "select", "l", "r"],
    "iphone-4s": [],
    "ipod-touch-5": [],
    "bb-classic": ["space", "enter", "menu", "trackpad"],
    "ipod-nano": ["select", "wheel"],
  };
  expect(Object.keys(PLAYGROUND_SHELLS).sort()).toEqual(Object.keys(presets).sort());
  // Every preset has a device; the playground's own shells are the set the tool renders, and each downloaded model is named.
  expect(Object.values(presets).sort()).toEqual(SCREENS.map((s) => s.id).sort());
  const own = Object.entries(PLAYGROUND_SHELLS).filter(([, dir]) => dir.endsWith("site/microts/shells")).map(([id]) => id);
  expect(own.sort()).toEqual([...SHELL_SETS.microts.ids].sort());
  for (const id of ["gba", "iphone-4s", "ipod-touch-5", "bb-classic"]) expect([id, DOWNLOADS[id]?.license]).toEqual([id, "CC BY 4.0"]);
  const devices = readFileSync(SITE + "src/playground/devices.ts", "utf8");
  for (const id of Object.keys(presets)) expect([id, devices.includes(`SHELLS.${id}!`) || devices.includes(`SHELLS["${id}"]!`)]).toEqual([id, true]);
  for (const [id, preset] of Object.entries(presets)) {
    const shell = profiles[id] as unknown as {
      art: string;
      partsArt?: string;
      width: number;
      height: number;
      partsWidth?: number;
      partsHeight?: number;
      screens: { upper: number[] };
      parts: number[][];
      controls: { button: string; rect: number[]; part: number | null }[];
      system?: Record<string, number[]>;
    };
    for (const url of [shell.art, shell.partsArt].filter(Boolean) as string[]) {
      const picture = readFileSync(join(PLAYGROUND_SHELLS[id]!, url.replace("/shells/", "")));
      expect([url, picture.subarray(0, 4).toString("latin1"), picture.subarray(8, 12).toString("latin1"), picture.length < 96_000]).toEqual([url, "RIFF", "WEBP", true]);
    }
    const { width, height } = SCREENS.find((s) => s.id === preset)!;
    const [, , w, h] = shell.screens.upper;
    // The picture's screen has the preset's shape to a twentieth; the preview is fitted inside it.
    expect([id, Math.abs(w! / h! / (width / height) - 1) < 0.05]).toEqual([id, true]);
    const inside = (rect: number[]) => rect[0]! >= 0 && rect[1]! >= 0 && rect[0]! + rect[2]! <= shell.width && rect[1]! + rect[3]! <= shell.height;
    expect([id, shell.controls.map((c) => c.button).sort()]).toEqual([id, [...controls[id]!].sort()]);
    for (const c of shell.controls) expect([id, c.button, inside(c.rect), c.part === null || c.part < shell.parts.length]).toEqual([id, c.button, true, true]);
    for (const rect of Object.values(shell.system ?? {})) expect([id, inside(rect)]).toEqual([id, true]);
    for (const part of shell.parts) expect([id, inside(part.slice(0, 4)), part[4]! + part[2]! <= shell.partsWidth!, part[5]! + part[3]! <= shell.partsHeight!]).toEqual([id, true, true, true]);
  }
  // The credits travel with the pictures, and name every author whose model a picture is made from.
  const credits = readFileSync(SITE + "shells/ATTRIBUTION.md", "utf8");
  for (const source of Object.values(DOWNLOADS)) expect(credits).toContain(source.url);
  expect(credits).toContain("Dibad");
});
