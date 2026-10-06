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

test("the homepage carries the title, the one-sentence lede and the five chapters", () => {
  expect(home).toContain('<link rel="canonical" href="https://3d.pocket.nexus/">');
  expect(home).toContain("<title>Pocket3D</title>");
  expect(home).toContain('aria-label="Create 3D for every machine you love"');
  expect(home).toContain('<p class="lede">Pocket3D is a hardware-native 3D stack for portable interactive software.</p>');
  const chapters = [...home.matchAll(/<section class="chap" id="([\w-]+)" style="--c:(var\(--\w+\))[^"]*">\s*<header class="head rv">\s*<div>\s*<h2>(.*?)<\/h2>\s*<p class="kick">([^<]+)<\/p>/g)];
  expect(chapters.map((chapter) => chapter[1])).toEqual(["hardware-native", "compiler-first", "purpose-built", "efficient-ui", "coding-agents"]);
  // the hero names each chapter, in order, with its colour and the line under its head
  const named = [...home.slice(home.indexOf('<nav class="chapters"'), home.indexOf("<!-- 1 -->")).matchAll(/<a href="#([\w-]+)" style="--c:(var\(--\w+\))"><b>([^<]+)<\/b><span>([^<]+)<\/span><\/a>/g)];
  expect(named.map((link) => link.slice(1))).toEqual(chapters.map((chapter) => [chapter[1], chapter[2], chapter[3].replace(/<[^>]+>/g, ""), chapter[4]]));
});

test("the bar, the hero, the closing call and the footer link where a visitor expects", () => {
  // the bar: PocketJS, then X, Discord and GitHub as icons, as on pocket.nexus; GitHub opens the repository's root
  const bar = home.slice(home.indexOf('<nav class="links"'), home.indexOf("</header>"));
  expect([...bar.matchAll(/<a class="(pill[^"]*)" href="([^"]+)"/g)].map((link) => [link[1], link[2]])).toEqual([
    ["pill", "https://pocketjs.pocket.nexus/"],
    ["pill ico", "https://x.com/pocket_js"],
    ["pill ico", "https://discord.gg/cTce4eXzSK"],
    ["pill ico", "https://github.com/pocket-nexus/pocketjs"],
  ]);
  expect((bar.match(/aria-label="[^"]+"><svg/g) ?? []).length).toBe(3);
  expect(home).not.toContain("pocketjs/tree/main/engine/pocket3d");
  // Pocket Studio is live: the hero offers it second, the closing call first, with a star on GitHub beside it
  // the hero does not name a product the reader has not met: it offers to try online
  expect(home).toContain('<a class="btn alt" href="https://studio.pocket.nexus/">Try it online</a>');
  expect(home).not.toContain("Open Pocket Studio");
  const close = home.slice(home.indexOf('<section class="close">'), home.indexOf("</main>"));
  expect([...close.matchAll(/<a class="(btn[^"]*)" href="([^"]+)"/g)].map((button) => [button[1], button[2]])).toEqual([
    ["btn", "https://studio.pocket.nexus/"],
    ["btn alt", "https://github.com/pocket-nexus/pocketjs"],
  ]);
  expect(close).toContain("Star on GitHub");
  // the closing text says what Pocket Studio is to Pocket3D before it sends the reader there
  expect(close.indexOf("Pocket3D is built into Pocket Studio")).toBeGreaterThan(0);
  expect(close.indexOf("Pocket3D is built into Pocket Studio")).toBeLessThan(close.indexOf('<a class="btn"'));
  expect(close).not.toContain("device kernels");
  for (const old of ["WIP", "Read the source", "Read the kernels"]) expect(home).not.toContain(old);
  // the address is behind the word Contact
  expect(home).toContain('<a href="mailto:support@pocket.nexus">Contact</a>');
  expect(home).not.toContain(">support@pocket.nexus<");
});

test("the hero's wall shows consoles' own frames, and chapter 1 carries no headline figures", () => {
  const wall = home.slice(home.indexOf('<div class="wall"'), home.indexOf('<nav class="chapters"'));
  const columns = wall.split('<div class="col">').slice(1);
  expect(columns.length).toBe(3);
  const shown = new Set<string>(), consoles = new Set<string>();
  for (const column of columns) {
    const frames = [...column.matchAll(/<img src="\/assets\/([^"]+)\.webp"[^>]*alt="([^"]*)" decoding="async"><figcaption style="--c:var\(--(\w+)\)"><b>([^<]+)<\/b> · ([^<]+)<\/figcaption>/g)];
    // five frames, written twice so the column loops; the copy has empty alt text
    expect(frames.length).toBe(10);
    const first = frames.slice(0, 5), copy = frames.slice(5);
    expect(copy.map((frame) => frame[1])).toEqual(first.map((frame) => frame[1]));
    for (const frame of copy) expect(frame[2]).toBe("");
    for (const frame of first) {
      // the caption's dot is the console's colour, and the alt text names the console that took the frame
      const colours: Record<string, string> = { "PS Vita": "cyan", PSP: "yellow", "3DS": "pink" };
      expect([frame[1], frame[3]]).toEqual([frame[1], colours[frame[5]]]);
      expect(frame[2]).toStartWith((frame[5] === "3DS" ? "Nintendo 3DS" : frame[5]) + " capture: ");
      shown.add(frame[1]);
      consoles.add(frame[5]);
    }
  }
  expect(shown.size).toBe(15);
  expect(consoles).toEqual(new Set(["PS Vita", "PSP", "3DS"]));
  // the reel under the hero is gone
  for (const old of ['class="strip"', 'class="reel"', "maneuver-3ds"]) expect(home).not.toContain(old);
  const native = home.slice(home.indexOf('id="hardware-native"'), home.indexOf("<!-- 2 -->"));
  expect(native).not.toContain('class="proof"');
  for (const figure of ["16 → 7 ms", "250 → 60 draws", "0 late frames"]) expect(home).not.toContain(figure);
});

test("a name a reader may not know carries a bubble that says what it is", () => {
  const tips = [...home.matchAll(/<span class="tip(?: under)?" tabindex="0" aria-describedby="(tip-\w+)">([^<]+)<span class="bubble" role="tooltip" id="(tip-\w+)"><b>([^<]+)<\/b>([^<]+)<\/span><\/span>/g)];
  expect(tips.map((tip) => [tip[1], tip[2]])).toEqual([["tip-ge", "GE"], ["tip-pica", "PICA200"], ["tip-gxm", "GXM"], ["tip-tokyo", "Pocket Tokyo"], ["tip-cityir", "CityIR"], ["tip-atlas", "Pocket Atlas"]]);
  for (const tip of tips) expect(tip[3]).toBe(tip[1]);
  const said = Object.fromEntries(tips.map((tip) => [tip[1], tip[4] + " " + tip[5]]));
  // each console's graphics chip or interface, beside the console's glyph in chapter 1
  expect(said["tip-ge"]).toContain("Sony's PSP");
  expect(said["tip-ge"]).toContain("no shaders");
  expect(said["tip-pica"]).toContain("Nintendo 3DS");
  expect(said["tip-gxm"]).toContain("PS Vita");
  const native = home.slice(home.indexOf('id="hardware-native"'), home.indexOf("<!-- 2 -->"));
  for (const id of ["tip-ge", "tip-pica", "tip-gxm"]) expect(native).toContain(`id="${id}"`);
  // the two games are named as examples where chapter 2 first speaks of them
  for (const id of ["tip-tokyo", "tip-atlas"]) expect(said[id]).toContain("an example app");
  // the IR under the glass belongs to one game: its bubble says Pocket3D games do not share it.
  // The glass is above the name, so this bubble opens below, and the name is not hidden from a reader.
  expect(said["tip-cityir"]).toContain("Pocket3D games do not share an IR");
  expect(said["tip-cityir"]).toContain("Pocket Tokyo's compiler");
  expect(home).toContain('<span class="ir"><span class="tip under" tabindex="0" aria-describedby="tip-cityir">CityIR<');
  expect(home).toContain(".under .bubble{left:50%;bottom:auto;top:calc(100% + 13px);translate:-50% 0;");
  expect(home).toContain('<div class="optics">\n          <div class="glass" aria-hidden="true">');
  // shown on hover and on focus, and kept inside its block below 1100 px
  expect(home).toContain(".tip:hover .bubble,.tip:focus .bubble{opacity:1;visibility:visible");
  expect(home).toContain("@media (max-width:1100px){\n  .tip{position:static}");
});

test("the Efficient UI chapter sets a screen's code beside the screen", () => {
  const chapter = home.slice(home.indexOf('id="efficient-ui"'), home.indexOf("<!-- 5 -->"));
  // between the engines and the agents
  expect(home.indexOf('id="purpose-built"')).toBeLessThan(home.indexOf('id="efficient-ui"'));
  expect(home.indexOf('id="efficient-ui"')).toBeLessThan(home.indexOf('id="coding-agents"'));
  const why = chapter.match(/<p class="why">(.*?)<\/p>/)![1];
  for (const said of ['<a href="https://pocketjs.pocket.nexus/">PocketJS</a>', "JSX", "SolidJS", "Tailwind", "32 MB", "333 MHz", "device kernels come from"]) expect(why).toContain(said);
  // four parts of the code, each with its number, and the same four places on the capture of that screen
  const marks = [...chapter.matchAll(/<span class="mk" data-m="(\d)" tabindex="0"><i>(\d)<\/i>/g)].map((mark) => [mark[1], mark[2]]);
  const areas = [...chapter.matchAll(/<span class="area" data-m="(\d)" style="left:([\d.]+)%;top:([\d.]+)%;width:([\d.]+)%;height:([\d.]+)%" aria-label="[^"]+"><i>(\d)<\/i><\/span>/g)];
  expect(marks).toEqual([["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]]);
  expect(areas.map((area) => [area[1], area[6]])).toEqual(marks);
  for (const area of areas) {
    expect(Number(area[2]) + Number(area[4])).toBeLessThanOrEqual(100);
    expect(Number(area[3]) + Number(area[5])).toBeLessThanOrEqual(100);
  }
  expect(chapter).toContain('<img src="/assets/tokyo-title.webp"');
  for (const said of ["Wordmark", "A flight over Shiba, around Tokyo Tower.", "Clock", "Rows"]) expect(chapter).toContain(said);
  expect((chapter.match(/<div class="card fact rv"/g) ?? []).length).toBe(3);
  expect(home).toContain('const light = (id) => { for (const el of $$("[data-m]", ui)) el.classList.toggle("on", el.dataset.m === id); };');
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
  expect(figure).toContain('<div class="glass" aria-hidden="true"><svg class="still" viewBox="0 0 120 106"><use href="#glass-back"/><use href="#glass-front"/></svg></div>');
  expect(figure).toContain('aria-describedby="tip-cityir">CityIR<');
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
  expect(pair).toMatch(/<h3><span class="tip"[^>]*>Pocket Atlas<span class="bubble".*?<\/span><\/span> <small>Griffith Observatory<\/small><\/h3>/);
  for (const old of ['class="stage"', "written once in Three.js", "source and result", "Another game, one machine", "One meaning, three mechanisms"]) expect(home).not.toContain(old);
  expect(pair).toContain('<div class="compare" id="compare">');
  expect(pair).toContain('<img class="top" src="/assets/overlook-three.webp"');
  // under it, the two halves as machines: what runs on each, and which parts the agent wrote
  const route = pair.slice(pair.indexOf('<div class="route"'), pair.indexOf("</figure>"));
  expect(pair.indexOf('<div class="route"')).toBeGreaterThan(pair.indexOf('<input type="range"'));
  const machines = route.split('<div class="mach').slice(1).map((machine) => ({
    name: machine.match(/<\/svg>([^<]+)<\/p>/)![1],
    parts: [...machine.matchAll(/<div class="part (made|out)"><h4>([^<]+)<\/h4><p>([^<]+)<\/p>(<svg class="wrote")?/g)].map((part) => [part[2], part[1], Boolean(part[4])]),
  }));
  expect(machines).toEqual([
    { name: "Development machine", parts: [["The scene", "made", true], ["The compiler", "made", true]] },
    { name: "PS Vita", parts: [["The renderer", "made", true], ["The compiled scene", "out", false]] },
  ]);
  expect(route).toContain("Three.js, running in a browser.");
  expect(route).toContain("Rust, written for these places.");
  expect(route).toMatch(/<p class="by"><svg class="wrote"[^>]*>.*?<\/svg>written by a coding agent, as one project<\/p>/);
  // the two cards share their rows, so the arrow from the compiler meets the compiled scene
  expect(home).toContain(".mach{grid-row:1 / span 4;display:grid;grid-template-rows:subgrid;");
  expect(home).toContain(".via{grid-row:4;");
  // the slider itself is as it was
  expect(pair).toContain('<input type="range" min="0" max="100" value="50" aria-label="Reveal the Three.js reference over the PS Vita capture">');
  expect(figure).not.toContain("Pocket Atlas");
  expect(figure).toMatch(/<h3><span class="tip"[^>]*>Pocket Tokyo<span class="bubble"/);
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
  expect(home).toContain(".head h2,.close h2{--u:min(3px,.125em);font:400 clamp(17px,2.2vw,29px)/1.6 var(--display)");
  for (const page of [home, notFound]) expect(page).not.toContain("Titan");
  // the turned slab, its script and the stars are gone
  for (const old of ['class="rig"', 'class="spark"', "function pose(", "LEAN", "rotateX("]) expect(home).not.toContain(old);
});

test("pixel headlines step their outline, extrusion and drop by no more than one cell of the face", () => {
  // Press Start 2P draws on a grid of 1/8 em. A step wider than a cell leaves the
  // copies below a letter apart from it, as stripes: the step is 3px and one cell
  // where the letters are under 24px, and no shadow of a headline is a fixed length.
  const rule = (page: string, selector: string) => page.slice(page.indexOf(selector), page.indexOf("}", page.indexOf(selector)));
  for (const [page, selector] of [[home, ".title{"], [home, ".head h2,.close h2{"], [notFound, "h1{"]] as const) {
    expect(rule(page, selector)).toContain("--u:min(3px,.125em)");
  }
  for (const [page, selector] of [[home, ".ch{"], [home, ".head h2,.close h2{"], [notFound, "h1{"]] as const) {
    const shadow = rule(page, selector).split("text-shadow:")[1];
    expect(shadow).toContain("0 var(--u) 0");
    expect(shadow).not.toMatch(/\dpx/);
  }
  // small letters take one step of extrusion, so the openings of A, E and R keep a dark row
  const small = (page: string, query: string) => page.slice(page.indexOf(query), page.indexOf("\n}", page.indexOf(query)));
  for (const [page, query, selector] of [
    [home, "@media (max-width:980px){", ".head h2,.close h2{"],
    [home, "@media (max-width:560px){", ".ch{"],
    [notFound, "@media (max-width:560px){", "h1{"],
  ] as const) {
    const shadow = rule(small(page, query), selector).split("text-shadow:")[1];
    expect(shadow).toContain("0 var(--u) 0");
    expect(shadow).not.toContain("0 calc(var(--u)*2) 0 var(--c2)");
    expect(shadow.split("calc(var(--u)*4)")).toHaveLength(1);
    expect(shadow).not.toMatch(/\dpx/);
  }
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
  expect(home).toContain(".chain::before{content:\"\";position:absolute;left:calc(var(--x) - 3px);top:19px;");
  // a pseudo-element states its own box: the page's "*" rule does not reach it
  expect(home).toContain(".chain li::before{content:\"\";box-sizing:border-box;position:absolute;left:calc(var(--x) - 44px - 14px);top:1px;width:28px;height:28px;");
  expect(home).not.toContain('class="brick"');
  // every engine's IR goes by a name of one kind
  expect(towers.map((tower) => tower[4].match(/compiled to its IR<\/span><b>([^<]+)<\/b>/)![1])).toEqual(["PlaceIR", "WorldIR", "CityIR", "MapIR"]);
  expect(chapter).not.toContain(".p3d");
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
