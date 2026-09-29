// tools/icons.ts — render an icon family from one SVG source.
//
//   bun tools/icons.ts          pocketjs.dev, from site/assets/favicon.svg
//   bun tools/icons.ts nexus    pocket.nexus, from site/nexus/mark.svg
//
// For pocketjs.dev, site/assets/favicon.svg is the only drawing. Everything a browser or a phone
// home screen asks for is rasterized from it here, so the mark can never drift
// between surfaces:
//
//   favicon.ico            16 + 32 + 48, PNG payloads in one container
//   favicon-96.png         crawlers and older Android that want a raster
//   apple-touch-icon.png   180, iOS home screen and Safari favourites
//   apple-touch-icon-*.png 120/152/167, so iOS never has to rescale
//   ...-precomposed.png    what older iOS fetches from the root with no link
//   icon-192/512.png       web app manifest
//   icon-512-maskable.png  Android adaptive icons, artwork inside the safe zone
//   og-image.png           the 1200x630 social card, rasterized from og-image.svg
//
// pocket.nexus gets the same treatment into site/nexus/public/, with a shorter
// apple-touch ladder, favicon.svg copied from the mark, and a social card
// captured from the homepage itself in its settled reduced-motion state, so
// the card shows the live wordmark and pocket rather than a second drawing.
//
// iOS picks the apple-touch-icon whose `sizes` is closest to what it wants and
// ignores the manifest when one exists, so the ladder below is what actually
// lands on a home screen. Two devices, two answers: 180 for iPhone, 152 and
// 167 for iPad. Anything that reads no link tag at all falls back to fetching
// /apple-touch-icon.png and /apple-touch-icon-precomposed.png from the root.
//
// Chrome does the rasterizing: it is the same renderer that will draw the SVG
// favicon, so the raster and the vector agree. The ICO container is written by
// hand rather than shelling out to ImageMagick, which keeps this runnable
// anywhere Bun and Chrome exist.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const BACKING = "#171226"; // the backing the mark is drawn on, matching favicon.svg
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Job = { file: string; size: number; bleed: boolean };
/**
 * Non-square art: rendered from its own SVG, or captured from a page after a
 * `prepare` expression resolves truthy.
 */
type Card = { file: string; width: number; height: number } & ({ source: string } | { page: string; prepare: string });
type Family = { out: string; source: string; favicon?: string; pngs: Job[]; cards: Card[] };

// `bleed` fills the canvas with the backing colour and insets the artwork: iOS
// and Android apply their own mask, and a transparent or self-rounded icon
// leaves dark notches in the corners once they do.
const PNGS: Job[] = [
  { file: "favicon-96.png", size: 96, bleed: false },
  { file: "apple-touch-icon.png", size: 180, bleed: true },
  { file: "apple-touch-icon-precomposed.png", size: 180, bleed: true },
  { file: "apple-touch-icon-167.png", size: 167, bleed: true },
  { file: "apple-touch-icon-152.png", size: 152, bleed: true },
  { file: "apple-touch-icon-120.png", size: 120, bleed: true },
  { file: "icon-192.png", size: 192, bleed: false },
  { file: "icon-512.png", size: 512, bleed: false },
  { file: "icon-512-maskable.png", size: 512, bleed: true },
];
const ICO = [16, 32, 48];
// The social card is a drawing of its own, but it carries the same mark, so it
// rasterizes here rather than being a committed PNG nothing regenerates.
const CARDS: Card[] = [
  { file: "og-image.png", source: "og-image.svg", width: 1200, height: 630 },
];

// The homepage settles at once under reduced motion. The card hides the
// controls (keeping a 34px top margin where the bar was), lays the scene out
// again at 1200x630 and waits for Titan One so the letters are drawn in the
// display face.
const NEXUS_CARD = `(async () => {
  await document.fonts.ready;
  const css = document.createElement("style");
  css.textContent = ".bar{height:34px;padding:0!important;visibility:hidden}.bar>*,.cta,.copy,.hint,#tags{display:none!important}";
  document.head.append(css);
  dispatchEvent(new Event("resize"));
  await new Promise((r) => setTimeout(r, 1500));
  return document.fonts.check('100px "Titan One"', "POCKETNXUS");
})()`;

const FAMILIES: Record<string, Family> = {
  pocketjs: { out: `${ROOT}site/assets/`, source: `${ROOT}site/assets/favicon.svg`, pngs: PNGS, cards: CARDS },
  nexus: {
    out: `${ROOT}site/nexus/public/`,
    source: `${ROOT}site/nexus/mark.svg`,
    favicon: "favicon.svg",
    pngs: [
      { file: "favicon-96.png", size: 96, bleed: false },
      { file: "apple-touch-icon.png", size: 180, bleed: true },
      { file: "apple-touch-icon-precomposed.png", size: 180, bleed: true },
      { file: "icon-192.png", size: 192, bleed: false },
      { file: "icon-512.png", size: 512, bleed: false },
      { file: "icon-512-maskable.png", size: 512, bleed: true },
    ],
    cards: [{ file: "og-image.png", page: "index.html", prepare: NEXUS_CARD, width: 1200, height: 630 }],
  },
};
const familyName = process.argv[2] ?? "pocketjs";
const family = FAMILIES[familyName];
if (!family) throw new Error(`Unknown icon family "${familyName}"; expected ${Object.keys(FAMILIES).join(" or ")}`);

class Chrome {
  #ws!: WebSocket;
  #proc!: Bun.Subprocess;
  #id = 0;
  #waiting = new Map<number, (v: any) => void>();

  async start() {
    if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`);
    const port = 9411;
    this.#proc = Bun.spawn(
      [
        CHROME,
        `--remote-debugging-port=${port}`,
        "--headless=new",
        "--hide-scrollbars",
        "--no-first-run",
        "--force-device-scale-factor=1",
        `--user-data-dir=${process.env.TMPDIR ?? "/tmp/"}pocketjs-icons`,
        "about:blank",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    let url = "";
    for (let i = 0; i < 100 && !url; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
        url = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
      } catch {}
      if (!url) await Bun.sleep(120);
    }
    if (!url) throw new Error("Chrome never opened a debugging target");
    this.#ws = new WebSocket(url);
    await new Promise((r) => (this.#ws.onopen = r as any));
    this.#ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id && this.#waiting.has(m.id)) {
        this.#waiting.get(m.id)!(m);
        this.#waiting.delete(m.id);
      }
    };
    await this.send("Page.enable");
    await this.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((res) => {
      const id = ++this.#id;
      this.#waiting.set(id, res);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async shot(html: string, width: number, height = width): Promise<Uint8Array> {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const done = new Promise<void>((res) => {
      const on = (e: MessageEvent) => {
        if (JSON.parse(String(e.data)).method === "Page.loadEventFired") {
          this.#ws.removeEventListener("message", on);
          res();
        }
      };
      this.#ws.addEventListener("message", on);
    });
    await this.send("Page.navigate", { url: `data:text/html;base64,${Buffer.from(html).toString("base64")}` });
    await done;
    await Bun.sleep(60); // let the SVG paint before the capture
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    return new Uint8Array(Buffer.from(r.result.data, "base64"));
  }

  /** Capture a real page with reduced motion, after `prepare` resolves truthy. */
  async page(url: string, width: number, height: number, prepare: string): Promise<Uint8Array> {
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await this.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const done = new Promise<void>((res) => {
      const on = (e: MessageEvent) => {
        if (JSON.parse(String(e.data)).method === "Page.loadEventFired") {
          this.#ws.removeEventListener("message", on);
          res();
        }
      };
      this.#ws.addEventListener("message", on);
    });
    await this.send("Page.navigate", { url });
    await done;
    const ready = await this.send("Runtime.evaluate", { expression: prepare, awaitPromise: true, returnByValue: true });
    if (ready.result?.exceptionDetails || ready.result?.result?.value !== true) {
      throw new Error(`${url}: prepare did not resolve true: ${JSON.stringify(ready.result)}`);
    }
    const r = await this.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await this.send("Emulation.setEmulatedMedia", { features: [] });
    return new Uint8Array(Buffer.from(r.result.data, "base64"));
  }

  stop() {
    this.#ws.close();
    this.#proc.kill();
  }
}

function page(svg: string, size: number, bleed: boolean): string {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  // 11% inset keeps the mark clear of the corner radius every platform mask
  // applies; without a bleed the artwork owns the whole canvas.
  const inset = bleed ? 0.11 : 0;
  const px = Math.round(size * inset);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:${bleed ? BACKING : "transparent"}}
img{position:absolute;left:${px}px;top:${px}px;width:${size - px * 2}px;height:${size - px * 2}px}
</style></head><body><img src="${src}"></body></html>`;
}

function cardPage(svg: string, width: number, height: number): string {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:${BACKING}}
img{display:block;width:${width}px;height:${height}px}
</style></head><body><img src="${src}"></body></html>`;
}

// PNG dimensions live in the IHDR chunk, at a fixed offset: the check below is
// the only proof that Chrome rendered at the size we asked for.
function pngSize(bytes: Uint8Array): [number, number] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [v.getUint32(16), v.getUint32(20)];
}

// ICO with PNG payloads: a 6-byte directory header, one 16-byte entry per
// image, then the PNG bytes. Every browser in use reads this form.
function ico(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const head = 6 + images.length * 16;
  const total = head + images.reduce((n, i) => n + i.png.length, 0);
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint16(0, 0, true); // reserved
  v.setUint16(2, 1, true); // type: icon
  v.setUint16(4, images.length, true);
  let entry = 6;
  let data = head;
  for (const { size, png } of images) {
    out[entry] = size >= 256 ? 0 : size; // 0 means 256
    out[entry + 1] = size >= 256 ? 0 : size;
    out[entry + 2] = 0; // palette size
    out[entry + 3] = 0; // reserved
    v.setUint16(entry + 4, 1, true); // colour planes
    v.setUint16(entry + 6, 32, true); // bits per pixel
    v.setUint32(entry + 8, png.length, true);
    v.setUint32(entry + 12, data, true);
    out.set(png, data);
    entry += 16;
    data += png.length;
  }
  return out;
}

const OUT = family.out;
const svg = readFileSync(family.source, "utf8");
if (family.favicon) {
  // the served favicon is the mark without its source-of-record comment
  writeFileSync(OUT + family.favicon, svg.replace(/^<!--[\s\S]*?-->\s*/, ""));
  console.log(`  ${family.favicon}  copied from ${family.source.slice(ROOT.length)}`);
}
const chrome = new Chrome();
await chrome.start();
try {
  for (const job of family.pngs) {
    const png = await chrome.shot(page(svg, job.size, job.bleed), job.size);
    const [w, h] = pngSize(png);
    if (w !== job.size || h !== job.size) throw new Error(`${job.file}: rendered ${w}x${h}, wanted ${job.size}`);
    writeFileSync(OUT + job.file, png);
    console.log(`  ${job.file}  ${job.size}x${job.size}  ${(png.length / 1024).toFixed(1)} KiB`);
  }
  const layers = [];
  for (const size of ICO) {
    layers.push({ size, png: await chrome.shot(page(svg, size, false), size) });
  }
  const container = ico(layers);
  writeFileSync(OUT + "favicon.ico", container);
  console.log(`  favicon.ico  ${ICO.join(" + ")}  ${(container.length / 1024).toFixed(1)} KiB`);
  for (const card of family.cards) {
    const png = "page" in card
      ? await chrome.page(`file://${OUT}${card.page}`, card.width, card.height, card.prepare)
      : await chrome.shot(cardPage(readFileSync(OUT + card.source, "utf8"), card.width, card.height), card.width, card.height);
    const [w, h] = pngSize(png);
    if (w !== card.width || h !== card.height) {
      throw new Error(`${card.file}: rendered ${w}x${h}, wanted ${card.width}x${card.height}`);
    }
    writeFileSync(OUT + card.file, png);
    console.log(`  ${card.file}  ${card.width}x${card.height}  ${(png.length / 1024).toFixed(1)} KiB`);
  }
} finally {
  chrome.stop();
}
