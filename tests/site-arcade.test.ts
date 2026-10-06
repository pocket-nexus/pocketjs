import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { candyHeadings } from "../site/candy.ts";
import { PIXEL_FONT_PRELOAD, renderPage } from "../site/templates.ts";

// The Arcade look: site/assets/arcade.css over the shared chrome, with
// headlines split into candy letters at build time by site/candy.ts.
const ROOT = new URL("..", import.meta.url).pathname;
const arcade = readFileSync(ROOT + "site/assets/arcade.css", "utf8");

test("headlines are split into candy letters in the HTML, with their text kept once", () => {
  const html = candyHeadings(
    '<section class="hero"><h1><span class="spectrum lit">Create UI on<br>every screen</span></h1></section>' +
      '<div class="vwrap"><h2 class="verb" id="t">Input &amp; <code>focus</code></h2></div>',
  );
  expect(html).toContain('<span class="spectrum lit ar-candy"><span class="ar-sr">Create UI on every screen</span>');
  expect(html).toContain('<span class="ar-vis" aria-hidden="true">');
  // one sticker per letter, hues cycling from the target's start, a <br> kept between lines
  expect(html).toContain('<span class="ar-ch ar-p" style="--i:0">C</span><span class="ar-ch ar-y" style="--i:1">r</span>');
  expect(html).toContain('</span><br><span class="ar-w">');
  // entities are one letter each and child elements give up their tags
  expect(html).toContain('<span class="ar-sr">Input &amp; focus</span>');
  expect(html).toContain('>&amp;</span>');
  expect(html).not.toContain("<code>");
  expect(html).toContain('id="t"');
});

test("every page ships its headline already split, with the pixel font preloaded", () => {
  const page = renderPage({ title: "Overview", active: "docs", body: '<article class="doc-content"><h1>Overview</h1></article>' });
  expect(page).toContain('<h1 class="ar-candy"><span class="ar-sr">Overview</span>');
  // arcade.css loads after site.css so it restyles the shared chrome
  expect(page.indexOf("/assets/arcade.css")).toBeGreaterThan(page.indexOf("/assets/site.css"));
  expect(page).toContain(PIXEL_FONT_PRELOAD);

  // the preloaded file is the one arcade.css declares, and text waits for it
  const file = PIXEL_FONT_PRELOAD.match(/href="([^"]+)"/)![1];
  expect(existsSync(ROOT + "site" + file)).toBe(true);
  expect(arcade).toContain(`src:url("${file}") format("woff2")`);
  expect(arcade).toContain("font-display:block");
  expect(existsSync(ROOT + "site/assets/fonts/OFL-PressStart2P.txt")).toBe(true);

  // the homepage bundle ends with the Arcade look; its head preloads the same font
  const build = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build).toContain('"tokens.css", "base.css", "chrome.css", "landing.css", "showcase.css", "arcade.css"');
  expect(build.match(/\$\{PIXEL_FONT_PRELOAD\}/g)).toHaveLength(2);
});

test("the wordmark is one run of white rounded text, and the sponsor button carries no emoji", () => {
  // Fredoka 600 in the ink colour, as 3d.pocket.nexus sets "Pocket3D": no
  // candy letters, so nothing to hop on hover.
  const page = renderPage({ title: "Overview", active: "docs", body: '<article class="doc-content"><h1>Overview</h1></article>' });
  expect(page).toContain('<span class="nm">PocketJS</span>');
  expect(arcade).toContain(':root .mark .nm{font:600 1.34rem/1 var(--ar-round);letter-spacing:0;color:var(--ink)}');
  expect(arcade).not.toContain(".mark:hover");
  expect(arcade).not.toContain(".nm.ar-candy");
  expect(arcade).not.toContain(".ar-sm");
  expect(readFileSync(ROOT + "site/candy.ts", "utf8")).not.toContain(".mark .nm");
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  expect(home.split('<span class="nm">PocketJS</span>')).toHaveLength(3);
  const cta = home.slice(home.indexOf('class="btn btn--pri spon-cta"'));
  expect(cta.slice(0, cta.indexOf("</a>"))).not.toMatch(/\p{Extended_Pictographic}/u);
});

test("a phone gets one column per section and the headline on three lines", () => {
  const landing = readFileSync(ROOT + "site/assets/landing.css", "utf8");
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  // Four sections give .cols its ratio in a style attribute, which a plain rule
  // in the narrow-screen query cannot override.
  expect(home.split('<div class="cols" style="grid-template-columns:').length - 1).toBe(4);
  const narrow = landing.slice(landing.indexOf("@media (max-width:1000px){"));
  expect(narrow.slice(0, narrow.indexOf("\n}"))).toContain(".cols{grid-template-columns:minmax(0,1fr) !important}");
  // Twelve letters a line, one em each, in a column 86px narrower than the screen.
  expect(home).toContain("Create UI on<br>every screen<br>you love");
  expect(arcade).toContain(":root .hero h1{font-size:clamp(1.15rem,calc(8.3vw - 7.4px),2rem);line-height:1.45}");
  for (const screen of [320, 360, 390, 430]) {
    const size = Math.min(32, Math.max(18.4, screen * 0.083 - 7.4));
    expect(size * 12).toBeLessThanOrEqual(screen - 86);
  }
});

test("the bar's buttons are set in the wordmark's rounded face, not the pixel face", () => {
  expect(arcade).toContain(":root .nav-links{gap:.5rem;font:600 .95rem/1 var(--ar-round);letter-spacing:.01em;color:var(--ink-2)}");
  // the buttons inherit it, and the menu they open is in the same face
  const button = arcade.slice(arcade.indexOf(":root .nav-links .menu-btn{"), arcade.indexOf("}", arcade.indexOf(":root .nav-links .menu-btn{")));
  expect(button).toContain("font:inherit");
  expect(arcade).toContain(":root .menu-list a{border:0;border-radius:9px;padding:.6rem .75rem;color:var(--ink);font:600 .92rem/1.2 var(--ar-round)");
  for (const rule of arcade.match(/:root \.nav-links[^{]*\{[^}]*\}/g) ?? []) expect(rule).not.toContain("--ar-px");
});

test("the bar leads to Pocket3D's site after Docs and Blog, and a phone finds it in the menu", () => {
  const templates = readFileSync(ROOT + "site/templates.ts", "utf8");
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  // the pages' template and the homepage, which writes its bar by hand
  for (const page of [templates, home]) {
    const bar = page.slice(page.indexOf('<nav class="nav-links"'), page.indexOf("</nav>", page.indexOf('<nav class="nav-links"')));
    expect(bar.indexOf("Blog")).toBeLessThan(bar.indexOf('<a href="https://3d.pocket.nexus/" class="p3d-link">Pocket3D</a>'));
    expect(bar.indexOf('<a href="https://3d.pocket.nexus/" class="p3d-link">Pocket3D</a>')).toBeLessThan(bar.indexOf('<div class="menu">'));
    expect(bar).toContain('<div class="menu-list">\n          <a href="https://3d.pocket.nexus/" class="p3d-item">Pocket3D</a>');
  }
  expect(arcade).toContain(":root .menu-list .p3d-item{display:none}\n@media (max-width:420px){\n  :root .nav-links > a.p3d-link:not(.ico){display:none}\n  :root .menu-list .p3d-item{display:block}\n}");
  const shell = readFileSync(ROOT + "site/for/shell.html", "utf8");
  expect(shell).toContain('<a class="lp-nav__link lp-nav__optional" href="https://3d.pocket.nexus/">Pocket3D</a>');
});
