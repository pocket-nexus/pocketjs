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
  const native = home.slice(home.indexOf('id="hardware-native"'), home.indexOf("<!-- 2 -->"));
  expect(native).not.toContain('class="proof"');
  for (const figure of ["16 → 7 ms", "250 → 60 draws", "0 late frames"]) expect(home).not.toContain(figure);
});

test("chapter 2 splits a line of Pocket Tokyo's scene into a mechanism for each console", () => {
  const figure = home.slice(home.indexOf('<div class="prism" id="prism">'), home.indexOf('<p class="differ">'));
  // three lines of the scene to pick from, the first one picked
  const lines = [...figure.matchAll(/<button type="button" class="line" aria-pressed="(true|false)"><svg[^>]*>.*?<\/svg><b>([^<]+)<\/b><span>([^<]+)<\/span><\/button>/g)];
  expect(lines.map((line) => line[1])).toEqual(["true", "false", "false"]);
  // one set of answers per line, under the same name, the first one shown
  const sets = figure.split('<div class="set').slice(1);
  expect(sets.length).toBe(3);
  expect(sets.map((set) => set.startsWith(' on">'))).toEqual([true, false, false]);
  const titles = new Set<string>(), shots = new Set<string>();
  for (const [i, set] of sets.entries()) {
    expect(set).toContain(`<p class="what">${lines[i][2]}</p>`);
    const rows = [...set.matchAll(/<article class="ans (vita|n3ds|psp)" style="--k:(\d)"><img src="\/assets\/([^"]+)\.webp" width="(\d+)" height="(\d+)" loading="lazy" alt="([^"]+)"><div><span class="on">([^<]+)<\/span><h4>([^<]+)<\/h4><p>([^<]+)<\/p><\/div><svg class="gl"[^>]*>(.*?)<\/svg><\/article>/g)];
    expect(rows.map((row) => [row[1], row[2]])).toEqual([["vita", "0"], ["n3ds", "1"], ["psp", "2"]]);
    // each row shows Pocket Tokyo captured on the console it names
    const console = { vita: "PS Vita", n3ds: "Nintendo 3DS", psp: "PSP" };
    for (const row of rows) {
      expect(row[3]).toStartWith("tokyo-");
      expect(row[6]).toStartWith(console[row[1] as keyof typeof console] + " capture");
      expect(row[7]).toStartWith(console[row[1] as keyof typeof console] + " · ");
      titles.add(row[8]);
      shots.add(row[3]);
    }
    // the three consoles' captures differ, and so do their drawings
    expect(new Set(rows.map((row) => row[3])).size).toBe(3);
    expect(new Set(rows.map((row) => row[10])).size).toBe(3);
  }
  // no two rows name the same mechanism; day and dusk are shown on every console
  expect(titles.size).toBe(9);
  expect([...shots].sort()).toEqual(["tokyo-3ds", "tokyo-3ds-dusk", "tokyo-day", "tokyo-dusk", "tokyo-psp", "tokyo-psp-dusk"]);
  // the glass is one drawing: still inside the figure, and live among the beams
  expect(figure).toContain('<div class="glass"><svg class="still" viewBox="0 0 120 106"><use href="#glass-back"/><use href="#glass-front"/></svg></div>');
  expect(figure).toContain("<b>CityIR</b>");
  for (const id of ["glass-back", "glass-front"]) expect(home).toContain(`<symbol id="${id}" viewBox="0 0 120 106">`);
  const beams = figure.match(/<svg class="beams" aria-hidden="true">(.*?)<\/svg>\s*<\/div>\s*$/s)![1];
  expect([...beams.matchAll(/<use class="body" href="#(glass-\w+)"\/>/g)].map((use) => use[1])).toEqual(["glass-back", "glass-front"]);
  // one beam in and its reflection, a spectrum and three rays inside the glass, three beams out; each beam is a halo and a core
  const paths = [...beams.matchAll(/<path class="([^"]+)"/g)].map((beam) => beam[1]);
  expect(paths).toEqual(["tri", "in", "o vita", "o n3ds", "o psp", "back", "fan", "ray vita", "ray n3ds", "ray psp", "in core", "o vita core", "o n3ds core", "o psp core"]);
  expect(beams).toContain('<g clip-path="url(#inside)"><path class="fan"');
  // the beam bends by Snell's law for glass of index 1.5, and is aimed from layout boxes
  expect(home).toContain("function aimBeams()");
  expect(home).toContain("eta = 1 / 1.5");
  expect(home).toContain("e.offsetLeft");
  expect(home).toContain('lines.forEach((line, i) => line.addEventListener("click", () => choose(i)));');
  // the table and the fan-out it replaced are gone
  for (const old of ['class="cols"', 'class="wire"', 'class="outs"', 'class="lrow', "LLVM does the same"]) expect(home).not.toContain(old);
  // the comparison of the reference with the capture is a figure of its own, named for its game
  const pair = home.slice(home.indexOf('<figure class="card viz pair rv"'), home.indexOf("<!-- 3 -->"));
  expect(pair).toContain("<h3>Pocket Atlas <small>Griffith Observatory</small></h3>");
  expect(pair).toContain('<div class="compare" id="compare">');
  expect(pair).toContain('<img class="top" src="/assets/overlook-three.webp"');
  expect(figure).not.toContain("Pocket Atlas");
  // the footer carries no credit line
  expect(home).not.toContain('class="credit"');
});

test("the title is the arcade marquee: letters of the pixel face through five hues, on a plate", () => {
  const title = home.match(/<h1 class="title" id="title" aria-label="Create 3D for every machine you love">(.*?)<\/h1>/s)![1];
  expect(title).toContain('<span class="plate0" aria-hidden="true">');
  expect(title).toContain('<span class="rail"></span>');
  const letters = [...title.matchAll(/<span class="ch ([pyclo])" style="--i:(\d+)">(.)<\/span>/g)];
  // every letter of the headline once, in order, each a step later than the one before and one hue on
  expect(letters.map((letter) => letter[3]).join("")).toBe("Create3Dforeverymachineyoulove");
  expect(letters.map((letter) => Number(letter[2]))).toEqual(letters.map((_, i) => i));
  expect(letters.map((letter) => letter[1]).join("")).toBe("pyclo".repeat(6));
  expect(title.split('<span class="ln">').length - 1).toBe(3);
  // the page loads the pixel face and no longer the round one, and the chapter heads use it
  expect(home).toContain("family=Press+Start+2P&");
  expect(home).toContain('--display:"Press Start 2P"');
  expect(home).toContain(".head h2,.close h2{font:400 clamp(17px,2.2vw,29px)/1.6 var(--display)");
  for (const page of [home, notFound]) expect(page).not.toContain("Titan");
  // the turned slab, its script and the stars are gone
  for (const old of ['class="rig"', 'class="spark"', "function pose(", "LEAN", "rotateX("]) expect(home).not.toContain(old);
});

test("chapter 3 stands each engine as one tower, read from the game down to the plate", () => {
  const chapter = home.slice(home.indexOf('id="purpose-built"'), home.indexOf("<!-- 4 -->"));
  const towers = [...chapter.matchAll(/<article class="eng rv" style="--c:var\(--(\w+)\);--d:[^"]+">\s*<figure><img src="\/assets\/([^"]+)"[^>]*><\/figure>\s*<h3>([^<]+)<\/h3>\s*<p>[^<]+<\/p>\s*<ol class="chain">(.*?)<\/ol>\s*<\/article>/gs)];
  expect(towers.map((tower) => tower[3])).toEqual(["Pocket Atlas", "Pocket Maneuver", "Pocket Tokyo", "OpenStrike"]);
  expect(new Set(towers.map((tower) => tower[1])).size).toBe(4);
  for (const tower of towers) {
    const links = [...tower[4].matchAll(/<li(?: class="(base)")? style="--n:(\d)"><span>([^<]+)<\/span><b>([^<]+)<\/b>(?:<em>[^<]+<\/em>)?<\/li>/g)];
    // three links say what each layer is to the one above it, and the last stands on Pocket3D
    expect(links.map((link) => [link[2], link[3]])).toEqual([["0", "written in its DSL"], ["1", "compiled to its IR"], ["2", "drawn by its renderers"], ["3", "standing on"]]);
    expect([links[3][1], links[3][4]]).toEqual(["base", "Pocket3D"]);
  }
  expect(chapter).toContain('<p class="plate rv"');
  // a thread of beads runs down each tower, and the old rows of bricks are gone
  expect(home).toContain(".chain::before{");
  expect(home).not.toContain('class="brick"');
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
