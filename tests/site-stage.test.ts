import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSingleLodStagePackage } from "../site/stage-package.ts";
import { BTN, PocketHost } from "../site/playground/host.js";
import {
  ICON_LINKS,
  SITE_FOOTER_DESC,
  SITE_FOOTER_DESC_SLOT,
  SITE_TITLE,
  injectSiteFooterDescription,
  renderPage,
} from "../site/templates.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PACKAGE = ROOT + "engine/pocket3d/examples/handheld/assets/dibad-psp/";

function glbJson(path: string): any {
  const bytes = new Uint8Array(readFileSync(path));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("glTF");
  let offset = 12;
  while (offset < bytes.length) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) {
      return JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length)).trim());
    }
    offset += 8 + length;
  }
  throw new Error("GLB has no JSON chunk");
}

test("homepage Stage package has one semantic screen and its declared suppression", () => {
  const profile = JSON.parse(readFileSync(PACKAGE + "profile.json", "utf8"));
  const gltf = glbJson(PACKAGE + profile.lods.orbit);
  type Material = { name?: string; extras?: Record<string, unknown> };
  const materials = gltf.materials as Material[];
  const primitiveMaterials: Material[] = gltf.meshes.flatMap((mesh: any) =>
    mesh.primitives.map((primitive: any) => materials[primitive.material]),
  );

  const screens = primitiveMaterials.filter((material) =>
    material.extras?.pocket3d_role === profile.screen.material_role ||
    material.name?.startsWith(profile.screen.material_name_prefix),
  );
  expect(screens).toHaveLength(profile.screen.expected_primitives);

  for (const entry of profile.suppressed_materials) {
    const matches = primitiveMaterials.filter((material) =>
      material.extras?.pocket3d_role === entry.material_role ||
      material.name?.startsWith(entry.material_name_prefix),
    );
    expect(matches).toHaveLength(entry.expected_primitives);
  }
});

test("homepage ships the four-chapter landing", () => {
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  // The 3D stage lives in the playground; the homepage must not mount it.
  // the motion chapter mounts the real runtime in the PSP model, booting one
  // app directly rather than the launcher deck
  expect(home).toContain("data-motion-stage");
  expect(home).toContain("data-stage-viewport");
  expect(home).not.toContain("lp-stage");
  // House style: no em dashes anywhere on the landing surfaces.
  for (const file of [
    "site/home.html",
    "site/for/shell.html",
    "site/for/interfaces.html",
    "site/for/games.html",
    "site/for/worlds.html",
    "site/for/agents.html",
  ]) {
    const source = readFileSync(ROOT + file, "utf8");
    expect(source).not.toContain("&mdash;");
    expect(source).not.toContain("—");
  }

  // The hero: the demo wall runs full bleed behind the headline, and the kit's
  // cover art is never shown here or anywhere else (site/bake-demo-wall.ts too).
  expect(home).toContain('class="hero-bg"');
  expect(home).toContain("/assets/pocketjs-demo-wall.mp4");
  expect(home).toContain("/assets/pocketjs-demo-wall.jpg");
  expect(home).toContain("UI runtime for<br>every kind of<br>computer");
  expect(home).toContain(
    "PocketJS is a portable application runtime that turns modern component code into",
  );
  for (const file of ["site/home.html", "site/bake-demo-wall.ts", "site/content/blog/pocket-figma.md"]) {
    expect(readFileSync(ROOT + file, "utf8")).not.toContain("figma-psp-cover-zoom");
  }

  // Four chapters, in order, each with its pixel-font heading.
  const chapters = ["write", "measured", "frame", "ecosystem"];
  let at = -1;
  for (const id of chapters) {
    const next = home.indexOf(`<section class="sect" id="${id}">`);
    expect(next).toBeGreaterThan(at);
    at = next;
  }
  for (const verb of ["Modern DX", "Performance", "Architecture", "Ecosystem"]) {
    expect(home).toContain(`<span class="verb spectrum lit">${verb}</span>`);
  }

  // The effect timeline keeps its own panel class. A short class name shared
  // with a prose link rule once underlined the entire panel in link green.
  expect(home).toContain('<div class="tl">');
  expect(home).not.toContain('class="pl"');
  expect(home).toContain('<a class="olink"');

  // The two hand-drawn diagrams and the redrawn flake histogram.
  expect(home).toContain('class="vs-col vs-pocket"');
  expect(home).toContain('class="vs-col vs-web"');
  // the browser column names the threads it hands work across
  expect(home).toContain("1 thread, 1 process");
  expect(home).toContain("4 threads, 2 processes");
  expect(home.match(/class="hop"/g)?.length).toBe(3);
  // the orders-of-magnitude panel, revealed on scroll
  expect(home).toContain("data-scale");
  expect(home).toContain("iPhone 17 Pro Max");
  expect(home).toContain("one part in 1536");
  expect(home).toContain("magnified 384 times");
  expect(home).toContain('class="hist"');
  // The histogram carries the published run: 22 outcomes, 9/60, frame 144.
  expect(home).toContain("22 outcomes");
  expect(home).toContain("assertion 9/60");
  expect(home).toContain("frame 144, every run, forever");

  // Framework code tabs: Solid, Vue Vapor, Octane. No plain-Vue SFC tab.
  for (const label of ['data-sub="c1">Solid<', "Vue Vapor", "Octane"]) {
    expect(home).toContain(label);
  }
  expect(home).not.toContain("Counter.vue");

  // Retired surfaces stay retired.
  expect(home).not.toContain("data-collage");
  expect(home).not.toContain("lp-dev");
  expect(home).not.toContain("data-mx");
  expect(home).not.toContain("What runs where");
  expect(home).not.toContain("Rich interactive JavaScript where no browser fits.");
  // Ambitions are a manifesto topic, not landing copy.
  expect(home.toLowerCase()).not.toContain("ambition ");

  // The sponsor gallery is generated from site/sponsors.json and thanks people
  // without asking for anything: avatars and a heading, no pitch, no tiers.
  expect(home).toContain('<div class="spon-gallery">{{SPONSOR_GALLERY}}</div>');
  expect(home).toContain('<span class="verb spectrum lit">Sponsors</span>');
  const sponsorSection = home.slice(home.indexOf('id="sponsors"'), home.indexOf("<footer"));
  // one line of thanks and one way in; still no amounts and no tier ladder
  expect(sponsorSection).toContain("thanks to your support");
  expect(sponsorSection).toContain("https://github.com/sponsors/doodlewind");
  for (const pitch of ["$", "tier", "Tier", "monthly"]) {
    expect(sponsorSection).not.toContain(pitch);
  }
  const roster = JSON.parse(readFileSync(ROOT + "site/sponsors.json", "utf8")) as {
    count: number;
    sponsors: { login: string; avatar: string }[];
  };
  expect(roster.sponsors).toHaveLength(roster.count);
  // pinned first, then alphabetical
  expect(roster.sponsors[0].login).toBe("ZephyrCloudIO");
  for (const s of roster.sponsors) {
    expect(existsSync(ROOT + "site" + s.avatar)).toBe(true);
  }
  // The generator only ever asks GitHub for public sponsorships.
  const gen = readFileSync(ROOT + "tools/sponsors.ts", "utf8");
  expect(gen).toContain("includePrivate: false");

  // Closing band: project provenance plus the remaining external call to action.
  expect(home).toContain("Pocket Lab");
  expect(home).toContain("Star on GitHub");
  expect(home).toContain("See use cases");

  // The /for/ pages are rendered with the shared landing chrome.
  const build0 = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build0).toContain("renderForPage");
  expect(build0).toContain('for/shell.html');
  expect(build0).toContain('copy(SITE + "assets/home.css", "assets/home.css")');

  // Homepage glue and styles: landing.css/landing.js, with home.css kept for /for/.
  const glue = readFileSync(ROOT + "site/assets/landing.js", "utf8");
  expect(glue).toContain("data-subtabs");
  expect(existsSync(ROOT + "site/assets/home.js")).toBe(false);
  const landingCss = readFileSync(ROOT + "site/assets/landing.css", "utf8");
  expect(landingCss).toContain(".hero-bg");
  // no bare `.pl` rule: it collided with the timeline panel's own class
  expect(landingCss).not.toMatch(/^\.pl[{:,]/m);
  // the delivery marker is positioned over the frame grid, never placed in it:
  // a grid item at column 5 pushes frame +4 and everything after it one cell right
  expect(landingCss).toMatch(/^\.deliver\{position:absolute;/m);
  expect(landingCss).not.toMatch(/^\.deliver\{grid-column/m);
  expect(landingCss).toContain("prefers-reduced-motion");
  expect(landingCss).not.toContain(".lp-dev");
  const homeCss = readFileSync(ROOT + "site/assets/home.css", "utf8");
  expect(homeCss).toContain(".lp-nav");
});

test("every compatibility entry cites a receipt that resolves", () => {
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  const compat = home.slice(home.indexOf('id="compat"'), home.indexOf('id="ecosystem"'));

  // Not a roadmap: no entry may sit there unsourced, so every chip is a link.
  expect(compat).not.toContain('<span class="cchip"');
  const chips = [...compat.matchAll(/<a class="cchip" href="([^"]+)"/g)].map((m) => m[1]);
  expect(chips.length).toBeGreaterThanOrEqual(24);

  for (const href of chips) {
    if (href.startsWith("/blog/")) {
      expect(existsSync(`${ROOT}site/content/blog/${href.slice(6, -1)}.md`)).toBe(true);
    } else if (href.startsWith("/docs/")) {
      expect(existsSync(`${ROOT}site/content/docs/${href.slice(6, -1)}.md`)).toBe(true);
    } else if (href === "/playground/") {
      // the browser's receipt is the live page itself
      expect(existsSync(ROOT + "site/playground/page.html")).toBe(true);
    } else if (href.includes("/tree/main/")) {
      // a source link is only honest if that path is still there
      expect(existsSync(ROOT + href.split("/tree/main/")[1])).toBe(true);
    } else {
      // otherwise it is a pull request on this repo
      expect(href).toMatch(/^https:\/\/github\.com\/pocket-stack\/pocketjs\/pull\/\d+$/);
    }
  }

  // Vapor cartridge targets are a separate story and stay out of this chapter.
  for (const absent of ["Playdate", "MeowBit", "Game Boy", "GBA", "NES"]) {
    expect(compat).not.toContain(absent);
  }

  // Receipts, so they open in their own tab like the rest of the references.
  expect(readFileSync(ROOT + "site/assets/landing.js", "utf8")).toContain('[data-refs] a, .cgrid a');

  // Keeping the hardware bootable is its own project, without linking away.
  expect(compat).toContain("Pocket Museum project repairs these machines");
});

test("Pocket Lab and Pocket Museum are not linked from the README or website", () => {
  const readme = readFileSync(ROOT + "README.md", "utf8");
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  const templates = readFileSync(ROOT + "site/templates.ts", "utf8");
  for (const source of [readme, home, templates]) {
    expect(source).not.toContain("https://pocketlab.build");
    expect(source).not.toContain("https://museum.pocketlab.build");
  }
  for (const source of [home, templates]) {
    // Every divider opens a group instead of trailing one, so a wrapped footer
    // never ends a line with a lone dot.
    expect(source.match(/<span class="fdot"/g)).toHaveLength(1);
    expect(source.match(/<span class="fgrp"><span class="fdot"/g)).toHaveLength(1);
    expect(source.match(/<span class="fgrp">/g)).toHaveLength(2);
  }
  const chromeCss = readFileSync(ROOT + "site/assets/chrome.css", "utf8");
  expect(chromeCss).toContain(".foot .cols2 .fdot{");
  expect(chromeCss).toContain(".foot .cols2 .fgrp{display:flex;");
});

test("the motion stage tells the reader which buttons change the study", () => {
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  const hint = home.match(/<figcaption class="stage-hint">([^<]+)<\/figcaption>/);
  expect(hint).not.toBeNull();
  const line = hint![1];
  // What the hint claims has to be what the guest app binds: left and right on
  // the d-pad, or the two shoulders. Nothing else steps the studies.
  const app = readFileSync(ROOT + "apps/motions/app.tsx", "utf8");
  expect(app).toContain("onButtonPress(BTN.RIGHT | BTN.RTRIGGER");
  expect(app).toContain("onButtonPress(BTN.LEFT | BTN.LTRIGGER");
  expect(line).toContain("d-pad");
  expect(line).toContain("L and R");
  // It rides with the model: shown once the runtime is live, gone in the 2D
  // fallback, where there is no model to press.
  const landingCss = readFileSync(ROOT + "site/assets/landing.css", "utf8");
  expect(landingCss).toContain(".pg-stage.is-ready .stage-hint{opacity:1}");
  expect(landingCss).toContain(".pg-stage.has-error .stage-hint{display:none}");
});

test("the PSP stage looks straight at the screen", () => {
  const profile = JSON.parse(
    readFileSync(ROOT + "engine/pocket3d/examples/handheld/assets/dibad-psp/profile.json", "utf8"),
  ) as { view: { desk_position_mm: number[]; desk_target_mm: number[] } };
  // a level camera: no downward tilt on the playground or the homepage
  expect(profile.view.desk_position_mm[1]).toBe(0);
  expect(profile.view.desk_target_mm[1]).toBe(0);
});

test("playground wraps its live framebuffer in the PSP model", () => {
  const playground = readFileSync(ROOT + "site/playground/page.html", "utf8");
  for (const marker of [
    "data-pocket-stage",
    "data-stage-viewport",
    "data-stage-canvas",
    "data-stage-screen",
    "data-stage-status",
  ]) {
    expect(playground).toContain(marker);
  }
  expect(playground).toContain('id="pg-canvas" class="pg-stage__screen" data-stage-screen');
  expect(playground).toContain("Dibad");
  expect(playground).toContain("creativecommons.org/licenses/by/4.0");
  expect(playground).not.toContain("screen-emu");
  expect(playground).not.toContain("data-btn");

  // Both surfaces share one stage module; the homepage boots a single app and
  // the playground supplies its own live-compiled host.
  const homeGlue = readFileSync(ROOT + "site/assets/landing.js", "utf8");
  expect(homeGlue).toContain('import("/assets/pocket-stage-web.js")');
  expect(homeGlue).toContain('bootApp: "motions-main"');
  const playgroundGlue = readFileSync(ROOT + "site/playground/playground.js", "utf8");
  expect(playgroundGlue).toContain('import("/assets/pocket-stage-web.js")');
  expect(playgroundGlue).toContain("mountPocketStage");
  expect(playgroundGlue).toContain("host,");
  expect(playgroundGlue).toContain("stageController?.refreshScreen()");
  expect(playgroundGlue).toContain("stageController?.releaseInput();\n      host.reset();");

  const adapter = readFileSync(ROOT + "site/assets/pocket-stage-web.js", "utf8");
  expect(adapter).toContain("const stageHost = suppliedHost ?? new PocketHost()");
  expect(adapter).toContain("if (suppliedHost)");
  expect(adapter).toContain("const onSuppliedHostError = stageHost.onError");
  expect(adapter).toContain("releaseButton();\n        onSuppliedHostError(error);");
  expect(adapter).toContain("new URL(profile.lods.orbit, new URL(profileUrl, location.href))");
  expect(adapter).toContain("loader.loadAsync(modelUrl)");
  expect(adapter).toContain("screenCanvasId: screenCanvas.id || null");
  expect(adapter).toContain("lastPressedPart");
  expect(adapter).toContain("return { refreshScreen, releaseInput: releaseButton,");

  const build = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build).not.toContain("screen.css");
  expect(existsSync(ROOT + "site/assets/screen.css")).toBe(false);

  // the stage's own styles moved into the shared chrome, which both the
  // playground and the homepage load
  const css = readFileSync(ROOT + "site/assets/chrome.css", "utf8");
  expect(css).toContain(".pg-stage.has-error .pg-stage__canvas { display: none; }");
  expect(css).toContain(".pg-stage.has-error .pg-stage__screen");
  expect(css).toContain(".pg-stage.has-error .pg-stage__viewport:focus-visible .pg-stage__screen");
});

test("playground spinner SVGs declare the browser image namespace", () => {
  const spinnerDir = ROOT + "assets/images/";
  const spinnerFiles = readdirSync(spinnerDir)
    .filter((file) => /^spinner-(?:0[0-7]|atlas)\.svg$/.test(file))
    .sort();
  expect(spinnerFiles).toEqual([
    "spinner-00.svg",
    "spinner-01.svg",
    "spinner-02.svg",
    "spinner-03.svg",
    "spinner-04.svg",
    "spinner-05.svg",
    "spinner-06.svg",
    "spinner-07.svg",
    "spinner-atlas.svg",
  ]);

  for (const file of spinnerFiles) {
    const svg = readFileSync(spinnerDir + file, "utf8");
    expect(svg).toMatch(/<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  }

  const compiler = readFileSync(ROOT + "site/playground/compiler-entry.ts", "utf8");
  expect(compiler).toContain("function svgImageBlob(source: string): Blob");
  expect(compiler).toContain("www.w3.org/2000/svg");
  expect(compiler).toContain("? svgImageBlob(await res.text())");
});

test("site build binds Vue Vapor runtime and JSX helper to the Pocket document", () => {
  const build = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build).toContain('document: "globalThis.__pocketDocument"');

  const runtimeStart = build.indexOf("async function bundleVueVapor");
  const helperStart = build.indexOf("function patchVaporHelperCode");
  const writerStart = build.indexOf("function writeVueVaporHelpers");
  const headersStart = build.indexOf("function writeStaticHeaders");
  expect(runtimeStart).toBeGreaterThan(-1);
  expect(helperStart).toBeGreaterThan(runtimeStart);
  expect(writerStart).toBeGreaterThan(helperStart);
  expect(headersStart).toBeGreaterThan(writerStart);

  const runtimeBuild = build.slice(runtimeStart, helperStart);
  expect(runtimeBuild).toContain("...VUE_VAPOR_DOCUMENT_DEFINE");
  expect(runtimeBuild).toContain('if (!code.includes("globalThis.__pocketDocument"))');
  expect(runtimeBuild).toContain("Vue Vapor browser runtime does not target the PocketJS document facade");

  const helperBuild = build.slice(helperStart, writerStart);
  expect(helperBuild).toContain("define: VUE_VAPOR_DOCUMENT_DEFINE");

  const helperWriter = build.slice(writerStart, headersStart);
  expect(helperWriter).toContain("const isVaporHelper = id === vaporHelperId");
  expect(helperWriter).toContain("isVaporHelper ? patchVaporHelperCode(code) : code");
  expect(helperWriter).toContain(
    'if (isVaporHelper && !output.includes("globalThis.__pocketDocument"))',
  );
  expect(helperWriter).toContain("Vue Vapor JSX helper does not target the PocketJS document facade");
});

test("the footer description belongs to the shared chrome, not the homepage", () => {
  const homeTemplate = readFileSync(ROOT + "site/home.html", "utf8");
  const forShell = readFileSync(ROOT + "site/for/shell.html", "utf8");
  // The homepage footer carries neither the slot nor the copy.
  expect(homeTemplate).not.toContain(SITE_FOOTER_DESC_SLOT);
  expect(homeTemplate).not.toContain(SITE_FOOTER_DESC);
  expect(forShell).toContain(SITE_FOOTER_DESC_SLOT);

  const forPage = injectSiteFooterDescription(forShell);
  const sharedPage = renderPage({ title: "Docs", active: "docs", body: "" });
  for (const html of [forPage, sharedPage]) {
    expect(html.split(SITE_FOOTER_DESC)).toHaveLength(2);
    expect(html).not.toContain(SITE_FOOTER_DESC_SLOT);
  }

  expect(() => injectSiteFooterDescription("")).toThrow("found 0");
  expect(() => injectSiteFooterDescription(SITE_FOOTER_DESC_SLOT.repeat(2))).toThrow("found 2");
});

test("the icon family is rendered from one drawing and linked from every head", () => {
  const svg = readFileSync(ROOT + "site/assets/favicon.svg", "utf8");
  const ihdr = (file: string): [number, number] => {
    const png = readFileSync(ROOT + "site/assets/" + file);
    expect(png.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n");
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };
  for (const [file, size] of [
    ["favicon-96.png", 96],
    ["apple-touch-icon.png", 180],
    ["apple-touch-icon-precomposed.png", 180],
    ["apple-touch-icon-167.png", 167],
    ["apple-touch-icon-152.png", 152],
    ["apple-touch-icon-120.png", 120],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["icon-512-maskable.png", 512],
  ] as const) {
    expect(ihdr(file)).toEqual([size, size]);
  }

  // iOS picks the apple-touch-icon closest to the size it wants and ignores the
  // manifest when one exists, so every rung it can ask for must be declared and
  // must really be that size on disk.
  const rungs = [...ICON_LINKS.matchAll(/rel="apple-touch-icon" sizes="(\d+)x\d+" href="\/([^"?]+)/g)];
  expect(rungs.map((m) => Number(m[1]))).toEqual([180, 167, 152, 120]);
  for (const [, size, file] of rungs) {
    expect(ihdr(file)).toEqual([Number(size), Number(size)]);
  }
  // Cache-busted: iOS keys the home screen icon by URL and keeps a page
  // screenshot if the first fetch came up empty.
  expect(ICON_LINKS).toContain("?v=");
  expect(ICON_LINKS).toContain('name="apple-mobile-web-app-title"');

  // Safari's bookmarks and Favorites grid read the plain root name, so that one
  // link carries neither a size nor a query.
  expect(ICON_LINKS).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">');
  // Safari could not render an SVG favicon before version 26, so the raster
  // favicons have to reach a size a Favorites tile can use.
  const pngFavicons = [...ICON_LINKS.matchAll(/rel="icon" href="\/([^"?]+\.png)(?:\?[^" ]*)?" type="image\/png" sizes="(\d+)x/g)];
  expect(Math.max(...pngFavicons.map((m) => Number(m[2])))).toBeGreaterThanOrEqual(192);
  for (const [, file, size] of pngFavicons) {
    expect(ihdr(file)).toEqual([Number(size), Number(size)]);
  }

  // favicon.ico carries 16, 32 and 48 as PNG payloads in one container
  const ico = readFileSync(ROOT + "site/assets/favicon.ico");
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  const count = ico.readUInt16LE(4);
  expect(count).toBe(3);
  const sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    const png = ico.subarray(offset, offset + size);
    expect(png.subarray(0, 8).toString("latin1")).toBe("\x89PNG\r\n\x1a\n");
    expect(png.readUInt32BE(16)).toBe(ico[entry]);
    sizes.push(ico[entry]);
  }
  expect(sizes).toEqual([16, 32, 48]);

  // Safari paints the pinned-tab mask itself: solid black, no gradients.
  const mask = readFileSync(ROOT + "site/assets/safari-pinned-tab.svg", "utf8");
  expect(mask).toContain('viewBox="0 0 16 16"');
  expect(mask).not.toContain("Gradient");
  expect(mask).not.toContain("#171226");

  const manifest = JSON.parse(readFileSync(ROOT + "site/assets/site.webmanifest", "utf8")) as {
    name: string;
    icons: { src: string; sizes: string; purpose?: string }[];
  };
  expect(manifest.name).toBe(SITE_TITLE);
  expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  // No SVG in the manifest: no home screen on either platform renders one, and
  // a "sizes":"any" entry outranks the rasters when a picker sorts by size.
  expect(manifest.icons.every((i) => i.src.endsWith(".png"))).toBe(true);
  for (const icon of manifest.icons) {
    expect(existsSync(ROOT + "site/assets/" + icon.src.slice(1))).toBe(true);
  }

  // One list, shared by all three heads on this site, and every file it names
  // is copied to the site root by the build.
  const build = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build.match(/\$\{ICON_LINKS\}/g)?.length).toBe(2);
  expect(readFileSync(ROOT + "site/templates.ts", "utf8")).toContain("${ICON_LINKS}");
  for (const href of [...ICON_LINKS.matchAll(/href="\/([^"]+)"/g)].map((m) => m[1].split("?")[0])) {
    expect(existsSync(ROOT + "site/assets/" + href)).toBe(true);
    expect(build).toContain(`"${href}"`);
  }
  // Nothing links it, but iOS fetches this path from the root on its own.
  expect(build).toContain('"apple-touch-icon-precomposed.png"');
  // The tab title says what this is.
  expect(SITE_TITLE).toBe("PocketJS · JavaScript UI runtime");

  // The generator reads the one drawing and nothing else.
  const gen = readFileSync(ROOT + "tools/icons.ts", "utf8");
  expect(gen).toContain("favicon.svg");
  expect(svg).toContain("<svg");
});

test("PocketJS favicon uses the yellow shell as its outer silhouette", () => {
  const favicon = readFileSync(ROOT + "site/assets/favicon.svg", "utf8");
  const backing = '<rect width="32" height="32" rx="7" fill="#171226"/>';
  const shell = 'rx="6" fill="none" stroke="#ffd23f" stroke-width="2.6"';
  expect(favicon).not.toContain(backing);
  expect(favicon).toContain('rx="6" fill="#171226" stroke="#ffd23f" stroke-width="2.6"');
  // One flat hue per element, so the mark survives being scaled down: the
  // shell is yellow, the screen dot and short key pink, the long key cyan.
  expect(favicon).not.toContain("Gradient");
  expect(favicon).toContain('<circle cx="10" cy="16" r="3.1" fill="#ff5f9e"/>');
  expect(favicon).toContain('width="10" height="2.2" rx="1.1" fill="#3fd0e8"/>');
  expect(favicon).toContain('width="6.5" height="2.2" rx="1.1" fill="#ff5f9e"/>');

  // Every other surface draws the same four shapes rather than its own copy.
  for (const file of [
    "site/home.html",
    "site/for/shell.html",
    "site/templates.ts",
    "site/assets/og-image.svg",
    "hosts/ipodtouch6/Icon.svg",
  ]) {
    const source = readFileSync(ROOT + file, "utf8");
    expect(source).toContain(shell);
    expect(source).toContain('<circle cx="10" cy="16" r="3.1" fill="#ff5f9e"/>');
  }

  // Classic hardware uses the selected muted palette, with unchanged iOS
  // mark geometry; the web and modern iOS surfaces retain the primary hues.
  const classic = readFileSync(ROOT + "hosts/iphone4s/Icon.svg", "utf8");
  expect(classic).toContain('rx="6" fill="none" stroke="#efce77" stroke-width="2.6"');
  expect(classic).toContain('<circle cx="10" cy="16" r="3.1" fill="#dc91ad"/>');
  expect(classic).toContain('width="10" height="2.2" rx="1.1" fill="#83c6d0"/>');

  const readme = readFileSync(ROOT + "README.md", "utf8");
  expect(readme).toContain('src="./site/assets/favicon.svg"');

  const ogImage = readFileSync(ROOT + "site/assets/og-image.svg", "utf8");
  expect(ogImage).toContain('<rect width="1200" height="630" fill="#171226"/>');

  // The social card is rasterized from that SVG rather than committed by hand.
  const gen = readFileSync(ROOT + "tools/icons.ts", "utf8");
  expect(gen).toContain("og-image.svg");
  const png = readFileSync(ROOT + "site/assets/og-image.png");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("single-LOD web package rewrites every profile reference to a copied asset", () => {
  const output = mkdtempSync(join(tmpdir(), "pocketjs-stage-"));
  try {
    const profile = emitSingleLodStagePackage(PACKAGE, output, "psp-profile.json", "orbit");
    const lods = new Set(Object.values(profile.lods));
    expect(lods).toEqual(new Set(["psp_lod3_eco.glb"]));
    for (const file of lods) expect(existsSync(join(output, file))).toBe(true);
    expect(existsSync(join(output, profile.attribution))).toBe(true);
    expect(readdirSync(output).filter((file) => file.endsWith(".glb"))).toHaveLength(1);

    const emitted = JSON.parse(readFileSync(join(output, "psp-profile.json"), "utf8"));
    expect(emitted.lods).toEqual(profile.lods);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("a fast button tap is released only after one guest turn observes it", () => {
  const host = new PocketHost();
  const seen: number[] = [];
  host.wasm = { tick() {}, drawHash: () => 0n };
  host.frameCb = (buttons: number) => seen.push(buttons);
  // Keep wake() from scheduling a real browser RAF in this deterministic test.
  host.rafId = 1;

  host.press(BTN.CIRCLE, true);
  const downTick = host.tickCount;
  host.afterNextTick(() => host.press(BTN.CIRCLE, false));
  expect(host.tickCount).toBe(downTick);
  expect(host.held & BTN.CIRCLE).toBe(BTN.CIRCLE);

  host._safeFrame();
  expect(seen).toEqual([BTN.CIRCLE]);
  expect(host.held & BTN.CIRCLE).toBe(0);

  host._safeFrame();
  expect(seen).toEqual([BTN.CIRCLE, 0]);
  host.rafId = 0;
});

test("a deferred button release can be canceled before a host reset", () => {
  const host = new PocketHost();
  host.wasm = { init() {}, ops: {}, tick() {}, drawHash: () => 0n };
  host.frameCb = () => {};
  host.rafId = 1;

  host.press(BTN.CIRCLE, true);
  const cancelRelease = host.afterNextTick(() => host.press(BTN.CIRCLE, false));
  const releaseInput = () => {
    cancelRelease();
    host.press(BTN.CIRCLE, false);
  };

  releaseInput();
  host.rafId = 0;
  host.reset();
  expect(host.held & BTN.CIRCLE).toBe(0);
});
