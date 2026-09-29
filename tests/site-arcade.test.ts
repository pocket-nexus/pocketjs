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
    '<section class="hero"><h1><span class="spectrum lit">Create on<br>every screen</span></h1></section>' +
      '<div class="vwrap"><h2 class="verb" id="t">Input &amp; <code>focus</code></h2></div>',
  );
  expect(html).toContain('<span class="spectrum lit ar-candy"><span class="ar-sr">Create on every screen</span>');
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

test("every page ships its wordmark already split, with the pixel font preloaded", () => {
  const page = renderPage({ title: "Overview", active: "docs", body: '<article class="doc-content"><h1>Overview</h1></article>' });
  expect(page).toContain('<span class="nm ar-candy ar-sm"><span class="ar-sr">PocketJS</span>');
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

test("the wordmark centers on the logo and the sponsor button carries no emoji", () => {
  expect(arcade).toContain(":root .mark .nm.ar-candy{--u:2px;font-size:.95rem;line-height:1;text-transform:none;padding:4.5px 2px}");
  expect(arcade).toContain(":root .mark .nm.ar-candy{position:relative;top:.1em}");
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  const cta = home.slice(home.indexOf('class="btn btn--pri spon-cta"'));
  expect(cta.slice(0, cta.indexOf("</a>"))).not.toMatch(/\p{Extended_Pictographic}/u);
});
