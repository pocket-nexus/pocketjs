import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

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
