import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderHomeShowcase } from "../site/home-showcase.ts";

const raw = readFileSync(new URL("../site/home.html", import.meta.url), "utf8");
const home = `<!doctype html><html><head><meta name="robots" content="index,follow"></head><body>${raw}<script type="module" src="/assets/landing.js"></script></body></html>`;
const hero = raw.replace("    {{SHOWCASE_HERO}}\n", "").match(/<section class="hero">[\s\S]*?<\/section>/)![0];
const heroContent = hero.slice(hero.indexOf('    <div class="col">'), hero.lastIndexOf("  </div>"));
const sections = [...raw.matchAll(/<section class="sect" id="([^"]+)">[\s\S]*?<\/section>/g)];

test("homepage preserves the original hero content and complete technical chapters", () => {
  const html = renderHomeShowcase(home);
  expect(html).toContain(heroContent);
  expect(html).toContain(hero.match(/<div class="hero-bg"[\s\S]*?<\/div>/)![0]);
  expect(html.match(/<h1>/g)).toHaveLength(1);
  expect(html).toContain('<script type="module" src="/assets/landing.js"></script>');
  let lastIndex = -1;
  for (const [section, id] of sections) {
    const index = html.indexOf(`<section class="sect" id="${id}">`);
    expect(index).toBeGreaterThan(lastIndex);
    lastIndex = index;
    if (id !== "ecosystem") expect(html).toContain(section);
  }
});

test("homepage retains existing case evidence and adds device setup routes", () => {
  const html = renderHomeShowcase(home);
  const ecosystem = sections.find(([, id]) => id === "ecosystem")![0];
  for (const [paragraph] of ecosystem.matchAll(/<p>[\s\S]*?<\/p>/g)) expect(html).toContain(paragraph);
  for (const [link] of ecosystem.matchAll(/<a class="story"[\s\S]*?<\/a>/g)) expect(html).toContain(link);
  expect(html.match(/data-app-card/g)).toHaveLength(11);
  for (const id of ["pocket-map", "pocket-doc", "pocket-shell", "pocket-term", "pspman"]) {
    expect(html).toContain(`id="try-${id}"`);
  }
  expect(html).toContain('content="index,follow"');
  expect(html).not.toContain("/_preview/");
  expect(html).not.toContain("{{SHOWCASE_");
});

test("approved hero strip exposes four setup routes without a second all-cases link", () => {
  const html = renderHomeShowcase(home);
  const shelf = html.match(/<aside class="pe-shelf[\s\S]*?<\/aside>/)![0];
  expect([...shelf.matchAll(/data-open-app="([^"]+)"/g)].map((match) => match[1]))
    .toEqual(["pspman", "pocket-shell", "openstrike", "pocket-voxel"]);
  expect(shelf).not.toContain("All cases");
  expect(shelf).toContain("Nintendo 3DS");
  expect(shelf).toContain("PS Vita");
});

test("homepage generation rejects missing or duplicate insertion slots", () => {
  expect(() => renderHomeShowcase(home.replace("{{SHOWCASE_HERO}}", ""))).toThrow("Expected one homepage marker");
  expect(() => renderHomeShowcase(home + "{{SHOWCASE_DIALOGS}}")).toThrow("Expected one homepage marker");
});
