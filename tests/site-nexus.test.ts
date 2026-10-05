import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// pocket.nexus is the organization homepage; PocketJS is one project under it,
// served at pocketjs.pocket.nexus while pocketjs.dev keeps working.
const ROOT = new URL("..", import.meta.url).pathname;
const PUBLIC = ROOT + "site/nexus/public/";
const home = readFileSync(PUBLIC + "index.html", "utf8");

function jsonc(path: string): any {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}
const domains = (config: any): string[] =>
  config.routes.filter((route: any) => route.custom_domain).map((route: any) => route.pattern).sort();
const meta = (key: string) =>
  home.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`))?.[1];

test("each hostname belongs to exactly one Worker", () => {
  const pocketjs = jsonc(ROOT + "site/wrangler.jsonc");
  const nexus = jsonc(ROOT + "site/nexus/wrangler.jsonc");
  expect(domains(pocketjs)).toEqual(["pocketjs.dev", "pocketjs.pocket.nexus", "www.pocketjs.dev"]);
  expect(domains(nexus)).toEqual(["pocket.nexus", "www.pocket.nexus"]);
  expect(nexus.name).not.toBe(pocketjs.name);
  expect(nexus.assets.directory).toBe("./public");
  // unknown paths get the branded page, which the 404-page handler requires
  expect(nexus.assets.not_found_handling).toBe("404-page");
  expect(existsSync(PUBLIC + "404.html")).toBe(true);

  const deploy = readFileSync(ROOT + ".github/workflows/deploy.yml", "utf8");
  expect(deploy).toContain("bunx wrangler deploy -c site/wrangler.jsonc");
  expect(deploy).toContain("bunx wrangler deploy -c site/nexus/wrangler.jsonc");
});

test("the homepage shares well: canonical URL, Open Graph and X card", () => {
  const desc =
    "An independent lab exploring new possibilities in computing, interaction and creation. We start with PocketJS.";
  expect(home).toContain('<link rel="canonical" href="https://pocket.nexus/">');
  expect(meta("description")).toBe(desc);
  expect(meta("og:title")).toBe("Pocket Nexus");
  expect(meta("og:description")).toBe(desc);
  expect(meta("og:url")).toBe("https://pocket.nexus/");
  expect(meta("og:image")).toBe("https://pocket.nexus/og-image.png");
  expect(meta("twitter:card")).toBe("summary_large_image");
  expect(meta("twitter:image")).toBe("https://pocket.nexus/og-image.png");

  // the card is a 1200x630 PNG; its size lives in the IHDR chunk
  const png = readFileSync(PUBLIC + "og-image.png");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  expect([meta("og:image:width"), meta("og:image:height")]).toEqual(["1200", "630"]);

  // every icon and the manifest the page links to is served from public/
  for (const [, href] of home.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="\/([^"?]+)/g)) {
    expect(existsSync(PUBLIC + href)).toBe(true);
  }
  const manifest = JSON.parse(readFileSync(PUBLIC + "site.webmanifest", "utf8"));
  for (const icon of manifest.icons) expect(existsSync(PUBLIC + icon.src.slice(1))).toBe(true);
});

test("the homepage links out to PocketJS, Pocket Shell and the social accounts", () => {
  expect(home).toContain("We start with PocketJS.");
  expect(home).not.toContain("It starts with PocketJS");
  // PocketJS opens on its pocket.nexus subdomain, from the button, the menu and the toy
  expect(home.match(/https:\/\/pocketjs\.pocket\.nexus\//g)!.length).toBeGreaterThanOrEqual(3);
  expect(home).not.toContain("pocketjs.dev");
  expect(home).toContain('href="https://github.com/pocket-nexus/pocket-shell"');
  expect(home).toContain('<button class="pill" type="button" aria-expanded="false" aria-controls="projects-list">Projects');
  for (const href of ["https://x.com/pocket_js", "https://discord.gg/cTce4eXzSK", "https://github.com/pocket-nexus"]) {
    expect(home).toContain(`href="${href}"`);
  }
  // the three verbs are coloured words, not spell-check squiggles
  expect(home).not.toContain("underline wavy");
});

test("the homepage offers Pocket3D beside PocketJS, and names the contact address", () => {
  // from the hero's second button and from the Projects menu
  expect(home.match(/href="https:\/\/3d\.pocket\.nexus\/"/g)!.length).toBe(2);
  const menu = home.slice(home.indexOf('id="projects-list"'), home.indexOf("</nav>"));
  expect([...menu.matchAll(/<b>([^<]+?)(?: <svg|<\/b>)/g)].map((entry) => entry[1])).toEqual(["PocketJS", "Pocket3D", "Pocket Shell"]);
  const cta = home.slice(home.indexOf('<div class="cta">'), home.indexOf("</main>"));
  expect([...cta.matchAll(/<a class="(btn[^"]*)" href="([^"]+)"/g)].map((button) => [button[1], button[2]])).toEqual([
    ["btn", "https://pocketjs.pocket.nexus/"],
    ["btn alt", "https://3d.pocket.nexus/"],
  ]);
  // every button is a shelf for the toys: the script measures each of them
  expect(home).toContain('for (const el of ctaWrap.querySelectorAll(".btn"))');
  // the mark both entries draw is the one the Pocket3D site serves as its favicon
  const mark = readFileSync(ROOT + "site/pocket3d/public/favicon.svg", "utf8");
  const shapes = [...mark.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
  expect(shapes.length).toBeGreaterThan(8);
  const symbol = home.match(/<symbol id="p3d"[^>]*>(.*?)<\/symbol>/s)![1];
  for (const shape of shapes) expect(symbol).toContain(shape);
  expect(home.match(/<use href="#p3d" width="32" height="32"\/>/g)!.length).toBe(2);
  expect(home).toContain('<a href="mailto:support@pocket.nexus">support@pocket.nexus</a>');
  expect(home).toContain('"email":"support@pocket.nexus"');
});

test("the pocket has an arced bottom everywhere it is drawn", () => {
  const mark = readFileSync(ROOT + "site/nexus/mark.svg", "utf8");
  const favicon = readFileSync(PUBLIC + "favicon.svg", "utf8");
  const outline = mark.match(/<path d="(M5 13h22[^"]+)"/)![1];
  expect(outline).toContain("C23.6 26 20 27.8 16 27.8");
  // the favicon is the mark itself, and the homepage inlines the same outline
  expect(favicon).toContain(outline);
  expect(home).toContain(outline);
  // the old pointed tip at (16,28) is gone from the mark, the favicon and the canvas pocket
  for (const source of [mark, favicon, home]) expect(source).not.toContain("L16 28");
  expect(home).not.toContain("Pm(16, 28)");
});
