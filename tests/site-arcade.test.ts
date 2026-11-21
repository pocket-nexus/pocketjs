import { expect, test } from "bun:test";
import { candyHeadings } from "../site/candy.ts";

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
