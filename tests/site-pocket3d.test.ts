import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

// 3d.pocket.nexus is the Pocket3D homepage. site/pocket3d/public/ is what the
// Worker deploys; site/pocket3d/logo/ holds the mark's generator and its study
// page, which only the local preview serves.
const ROOT = new URL("..", import.meta.url).pathname;
const SITE = ROOT + "site/pocket3d/";
const PUBLIC = SITE + "public/";
const home = readFileSync(PUBLIC + "index.html", "utf8");
const notFound = readFileSync(PUBLIC + "404.html", "utf8");
const logo = readFileSync(SITE + "logo/index.html", "utf8");

function jsonc(path: string): any {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

test("each hostname belongs to exactly one Worker, and main deploys all three", () => {
  const pocket3d = jsonc(SITE + "wrangler.jsonc");
  const others = [jsonc(ROOT + "site/wrangler.jsonc"), jsonc(ROOT + "site/nexus/wrangler.jsonc")];
  expect(pocket3d.routes).toEqual([{ pattern: "3d.pocket.nexus", custom_domain: true }]);
  for (const other of others) {
    expect(other.name).not.toBe(pocket3d.name);
    expect(other.routes.map((route: any) => route.pattern)).not.toContain("3d.pocket.nexus");
  }
  expect(pocket3d.assets.directory).toBe("./public");
  expect(pocket3d.assets.not_found_handling).toBe("404-page");
  expect(existsSync(PUBLIC + "404.html")).toBe(true);
  expect(readFileSync(ROOT + ".github/workflows/deploy.yml", "utf8")).toContain("bunx wrangler deploy -c site/pocket3d/wrangler.jsonc");
});

test("the homepage carries the title, the one-sentence lede and the four chapters", () => {
  expect(home).toContain('<link rel="canonical" href="https://3d.pocket.nexus/">');
  expect(home).toContain("<title>Pocket3D</title>");
  expect(home).toContain('aria-label="Create 3D for every machine you love"');
  expect(home).toContain('<p class="lede">Pocket3D is a hardware-native 3D stack for portable interactive software.</p>');
  for (const id of ["hardware-native", "compiler-first", "purpose-built", "coding-agents"]) {
    expect(home).toContain(`<section class="chap" id="${id}"`);
  }
  // each word of the title names its own text twice: the extrusion and the gloss are drawn from the attribute
  for (const [, shown, text] of home.matchAll(/<span class="f" data-t="([^"]+)"[^>]*>([^<]+)<\/span>/g)) expect(shown).toBe(text);
});

test("the bar, the hero and the footer link where a visitor expects", () => {
  // the GitHub pill opens the repository's root, not a directory inside it
  expect(home).toContain('<a class="pill go" href="https://github.com/pocket-nexus/pocketjs">GitHub</a>');
  expect(home).not.toContain("pocketjs/tree/main/engine/pocket3d");
  // Pocket Studio is named as unfinished wherever the page offers it
  const studio = home.match(/<a class="btn alt" href="https:\/\/studio\.pocket\.nexus\/"[^>]*>(.*?)<\/a>/)![1];
  expect(studio).toContain('<span class="wip" aria-hidden="true">WIP</span>');
  expect(home).not.toContain("Read the source");
  expect(home).toContain('<a href="mailto:support@pocket.nexus">support@pocket.nexus</a>');
});

test("the reel shows consoles' own frames, and chapter 1 carries no headline figures", () => {
  const reel = home.slice(home.indexOf('<div class="reel">'), home.indexOf("<!-- 1 -->"));
  const frames = [...reel.matchAll(/<img src="\/assets\/([^"]+)\.webp"[^>]*alt="([^"]*)"><figcaption><b>([^<]+)<\/b> on a ([^<]+)<\/figcaption>/g)];
  // the list is written twice so the strip loops; the copy has empty alt text
  expect(frames.length % 2).toBe(0);
  const shown = frames.slice(0, frames.length / 2), copy = frames.slice(frames.length / 2);
  expect(copy.map((frame) => frame[1])).toEqual(shown.map((frame) => frame[1]));
  for (const frame of shown) expect(frame[2].length).toBeGreaterThan(20);
  for (const frame of copy) expect(frame[2]).toBe("");
  expect(shown.filter((frame) => frame[3] === "Pocket Tokyo").length).toBeGreaterThanOrEqual(2);
  expect(new Set(shown.map((frame) => frame[4]))).toEqual(new Set(["PS Vita", "PSP"]));
  expect(home).not.toContain("maneuver-3ds");
  // the city's data sources are credited where its frames are shown
  expect(home).toContain("Project PLATEAU (MLIT Japan)");
  expect(home).toContain('<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>');
  const native = home.slice(home.indexOf('id="hardware-native"'), home.indexOf("<!-- 2 -->"));
  expect(native).not.toContain('class="proof"');
  for (const figure of ["16 → 7 ms", "250 → 60 draws", "0 late frames"]) expect(home).not.toContain(figure);
});

test("chapter 2 shows one part of the scene as a different mechanism on each console", () => {
  const table = home.slice(home.indexOf('<div class="lower"'), home.indexOf('<p class="differ">'));
  const rows = table.split('<div class="lrow').slice(1);
  // a header row, then one row per part of the scene
  expect(rows.length).toBe(4);
  expect(rows[0]).toContain("Three.js");
  for (const [n, row] of rows.entries()) expect(row).toContain(`--r:${n + 1}`);
  const titles = new Set<string>();
  for (const row of rows.slice(1)) {
    expect(row).toContain('<div class="says2" role="rowheader">');
    const cells = [...row.matchAll(/<div class="how (vita|n3ds|psp)" role="cell">.*?<h4>([^<]+)<\/h4><p>([^<]+)<\/p><\/div>/g)];
    expect(cells.map((cell) => cell[1])).toEqual(["vita", "n3ds", "psp"]);
    // each console's cell has a drawing of its own
    expect(new Set([...row.matchAll(/<svg class="gl"[^>]*>(.*?)<\/svg>/g)].map((drawing) => drawing[1])).size).toBe(3);
    for (const cell of cells) titles.add(cell[2]);
  }
  // no two cells of the table name the same mechanism
  expect(titles.size).toBe(9);
  expect(table).toContain('<p class="ir" aria-hidden="true"><b>CityIR</b>');
  // the fan-out it replaces is gone, and the comparison of the reference with the capture stays
  for (const old of ['class="cols"', 'class="wire"', 'class="outs"', "LLVM does the same"]) expect(home).not.toContain(old);
  expect(home).toContain('<div class="compare" id="compare">');
  expect(home).toContain('<img class="top" src="/assets/overlook-three.webp"');
});

test("the title rests in one pose and the pointer leans it a few degrees", () => {
  // 26 and 20 degrees per unit of aim: a lean of 0.09 is about 2.3 degrees of turn and 1.8 of tilt
  const lean = Number(home.match(/LEAN = ([0-9.]+)/)![1]);
  expect(lean).toBeGreaterThan(0);
  expect(lean * 26).toBeLessThan(3);
  // nothing moves it while the pointer is elsewhere
  expect(home).not.toMatch(/Math\.sin\(time/);
});

test("the Worker deploys only what the homepage uses", () => {
  // public/ holds the two pages, the icon family, the social card and the captures; studies stay out of it
  expect(readdirSync(PUBLIC).sort()).toEqual([
    "404.html", "apple-touch-icon-precomposed.png", "apple-touch-icon.png", "assets", "favicon-96.png", "favicon.ico",
    "favicon.svg", "icon-192.png", "icon-512-maskable.png", "icon-512.png", "index.html", "og-image.png", "site.webmanifest",
  ]);
  const used = new Set([...home.matchAll(/src="\/assets\/([^"]+)"/g)].map((match) => match[1]));
  const shipped = readdirSync(PUBLIC + "assets");
  expect(shipped.sort()).toEqual([...used].sort());
  // the captures are WebP, and together they stay under 700 KiB
  for (const file of shipped) expect(file).toMatch(/\.webp$/);
  expect(shipped.reduce((sum, file) => sum + statSync(PUBLIC + "assets/" + file).size, 0)).toBeLessThan(700 * 1024);
  for (const html of [home, notFound]) {
    for (const [, path] of html.matchAll(/(?:src|href)="(\/[^"#?]*)"/g)) {
      expect([path, existsSync(PUBLIC + path.slice(1) + (path.endsWith("/") ? "index.html" : ""))]).toEqual([path, true]);
    }
  }
});

test("the mark is the generator's output wherever the site draws it", async () => {
  expect(logo).toContain('<meta name="robots" content="noindex">');
  expect(logo).toContain('from "./mark3d.js"');
  const { mark3d, OPTIONS } = await import(SITE + "logo/mark3d.js");
  const drawn = mark3d(OPTIONS.find((option: any) => option.id === "brick").opts);
  expect(readFileSync(SITE + "mark.svg", "utf8")).toContain(drawn);
  expect(readFileSync(PUBLIC + "favicon.svg", "utf8").trim()).toBe(drawn);
  const shapes = [...drawn.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
  expect(shapes.length).toBeGreaterThan(8);
  for (const html of [home, notFound]) for (const shape of shapes) expect(html).toContain(shape);
  // every option keeps the PocketJS face: plum panel, pink lens, cyan and pink keys
  for (const option of OPTIONS) {
    const svg = mark3d(option.opts);
    for (const fill of ["#171226", "#ff5f9e", "#3fd0e8", "url(#m3d-gold)"]) expect(svg).toContain(`fill="${fill}"`);
  }
});

test("the homepage shares well: icon family, manifest and a 1200 x 630 social card", () => {
  const meta = (key: string) => home.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`))?.[1];
  expect(meta("og:image")).toBe("https://3d.pocket.nexus/og-image.png");
  expect(meta("twitter:image")).toBe("https://3d.pocket.nexus/og-image.png");
  expect(meta("twitter:card")).toBe("summary_large_image");
  // the card is a PNG whose size lives in the IHDR chunk; it is captured from og-card.html beside public/
  const card = readFileSync(PUBLIC + "og-image.png");
  expect([card.readUInt32BE(16), card.readUInt32BE(20)]).toEqual([1200, 630]);
  expect([meta("og:image:width"), meta("og:image:height")]).toEqual(["1200", "630"]);
  expect(card.length).toBeLessThan(200 * 1024);
  expect(readFileSync(SITE + "og-card.html", "utf8")).toContain('<img src="mark.svg"');
  expect(readFileSync(ROOT + "tools/icons.ts", "utf8")).toContain("site/pocket3d/og-card.html");
  // every icon the pages and the manifest name is served from public/
  for (const html of [home, notFound]) {
    for (const [, href] of html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="\/([^"?]+)/g)) {
      expect([href, existsSync(PUBLIC + href)]).toEqual([href, true]);
    }
  }
  const manifest = JSON.parse(readFileSync(PUBLIC + "site.webmanifest", "utf8"));
  expect(manifest.name).toBe("Pocket3D");
  for (const icon of manifest.icons) expect(existsSync(PUBLIC + icon.src.slice(1))).toBe(true);
});

test("page copy has no em dashes and links only to public places", () => {
  const allowed = [
    "https://pocket.nexus/",
    "https://pocketjs.pocket.nexus/",
    "https://github.com/pocket-nexus",
    "https://x.com/pocket_js",
    "https://discord.gg/cTce4eXzSK",
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com",
    "https://3d.pocket.nexus/",
    "https://studio.pocket.nexus/",
    "https://www.openstreetmap.org/copyright",
  ];
  for (const html of [home, notFound, logo]) {
    expect(html).not.toContain("—");
    expect(html).not.toContain("pocket-stack");
    for (const [, href] of html.matchAll(/href="(https?:[^"]+)"/g)) {
      expect([href, allowed.some((prefix) => href.startsWith(prefix))]).toEqual([href, true]);
      // these games' repositories are private: a link to one is a 404 for a visitor
      expect(href).not.toMatch(/pocket-nexus\/pocket-(atlas|maneuver|tokyo|requiem|studio)/);
    }
  }
});

test("the repository names its three entry points", () => {
  const readme = readFileSync(ROOT + "README.md", "utf8");
  for (const entry of ["pocket3d/README.md", "microts/README.md"]) {
    expect(existsSync(ROOT + entry)).toBe(true);
    expect(readme).toContain(`(./${entry})`);
  }
  expect(readme).toContain("## In this repository");
  expect(readme).toContain("https://3d.pocket.nexus");
  // the Pocket3D entry point maps to code that exists
  const pocket3d = readFileSync(ROOT + "pocket3d/README.md", "utf8");
  for (const [, path] of pocket3d.matchAll(/\]\(\.\.\/([^)#]+)/g)) expect([path, existsSync(ROOT + path)]).toEqual([path, true]);
  const microts = readFileSync(ROOT + "microts/README.md", "utf8");
  for (const [, path] of microts.matchAll(/\]\(\.\.?\/([^)#]+)/g)) {
    const base = existsSync(ROOT + "microts/" + path) ? ROOT + "microts/" : ROOT;
    expect([path, existsSync(base + path)]).toEqual([path, true]);
  }
});
