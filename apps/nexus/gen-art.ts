// apps/nexus/gen-art.ts — bake the Pocket Nexus 3DS art.
//
//   bun apps/nexus/gen-art.ts
//
// Renders apps/nexus/art/draw.js (the homepage's canvas art, ported) and the
// homepage's lede typography in headless Chrome at 3DS pixel size, bleeds the
// colour of every opaque edge into the transparent texels around it (the 3DS
// filters bilinearly with straight alpha, so bare transparent black would
// fringe), and writes power-of-two PNGs to apps/nexus/art/ plus art.ts, the
// manifest the app imports: literal image names for the build's image scan
// and the glyph metrics the physics bodies are sized from. images.json asks
// for linear filtering on every sprite.
//
// Fonts load from Google Fonts at bake time (Titan One, Fredoka, IBM Plex);
// the PNGs are the committed product art, so builds never need the network.

import { decodePng } from "../../framework/compiler/pak.ts";
import { HeadlessChrome } from "../../tools/headless-chrome.ts";
import { encodePNG } from "../../tools/png.ts";
import {
  FS, LETTER_SPRITE, POCKET_K, POCKET_LW, POCKET_PW, POCKET_SPRITE, POCKET_TIP_IN_SPRITE, POCKET_CX, POCKET_TOP_Y,
  FLOOR_Y, BOTTOM_W, BOTTOM_H, TOP_W, TOP_H, TOY_R, TOY_SPRITE, PARTICLE_SPRITE, WORD, ROW_SPLIT, LETTER_GAP, ROW_GAP,
  WORD_TOP, HINGE, BOTTOM_X, BOTTOM_Y,
} from "./scene.ts";

const HERE = new URL(".", import.meta.url).pathname;
const ART = HERE + "art/";
const PORT = 9351;

const FONTS =
  "https://fonts.googleapis.com/css2?family=Titan+One&family=Fredoka:wght@600&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@500&display=block";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS}">
<style>html,body{margin:0;background:transparent}
#lede{position:absolute;left:0;top:0;width:512px;text-align:center;font:12px/1.42 "IBM Plex Sans";color:#cbbde2;-webkit-font-smoothing:antialiased}
#lede p{margin:0 auto;max-width:356px;text-wrap:balance}
.v{color:rgb(var(--h));font:600 1.08em/1 "Fredoka";letter-spacing:.01em;white-space:nowrap;padding:0 .14em;margin:0 -.04em;border-radius:.3em;
  text-shadow:0 1px 0 #0e091a;background:linear-gradient(180deg,transparent 54%,rgba(var(--h),.2) 54%,rgba(var(--h),.2) 94%,transparent 94%)}
.v1{--h:63,208,232}.v2{--h:255,95,158}.v3{--h:255,210,63}
.starts{display:block;margin-top:.25em;color:#fcf6ff;font-weight:600}
#copy{position:absolute;left:0;top:100px;font:500 9px/16px "IBM Plex Mono";letter-spacing:.06em;color:#8e80ac;white-space:nowrap;-webkit-font-smoothing:antialiased}
</style></head><body>
<div id="lede"><p>An independent lab exploring new possibilities in <span class="v v1">computing</span>, <span class="v v2">interaction</span> and <span class="v v3">creation</span>. <span class="starts">We start with PocketJS.</span></p></div>
<div id="copy">© 2026 Pocket Nexus</div>
</body></html>`;

// ---- images -----------------------------------------------------------------

function isPow2(n: number): boolean {
  return n >= 8 && n <= 512 && (n & (n - 1)) === 0;
}

/** Copy the colour of opaque neighbours into fully transparent texels. */
function bleed(rgba: Uint8Array, w: number, h: number): void {
  for (let pass = 0; pass < 6; pass++) {
    const src = rgba.slice();
    let changed = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (src[i + 3] !== 0 || (src[i] | src[i + 1] | src[i + 2]) !== 0) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = (ny * w + nx) * 4;
          if (src[j + 3] === 0 && (src[j] | src[j + 1] | src[j + 2]) === 0) continue;
          r += src[j]; g += src[j + 1]; b += src[j + 2]; n++;
        }
        if (n > 0) {
          rgba[i] = Math.round(r / n); rgba[i + 1] = Math.round(g / n); rgba[i + 2] = Math.round(b / n);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

const written: string[] = [];

/** A canvas's PNG data URL, as bytes. */
const dataUrlBytes = (url: string) => Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));

async function writePng(name: string, bytes: Uint8Array, expectW: number, expectH: number): Promise<string> {
  const image = decodePng(bytes);
  if (image.width !== expectW || image.height !== expectH) throw new Error(`${name}: ${image.width}x${image.height}, expected ${expectW}x${expectH}`);
  if (!isPow2(image.width) || !isPow2(image.height)) throw new Error(`${name}: not a power-of-two texture`);
  const rgba = new Uint8Array(image.rgba);
  bleed(rgba, image.width, image.height);
  await Bun.write(ART + name, encodePNG(rgba, image.width, image.height));
  const key = `art/${name}`;
  written.push(key);
  return key;
}

async function main() {
  const chrome = await HeadlessChrome.start({ port: PORT, profile: `${process.env.TMPDIR ?? "/tmp/"}pocketjs-nexus-art` });
  const evaluate = (expression: string) => chrome.evaluate(expression);
  try {
    await chrome.viewport(512, 256);
    await chrome.html(PAGE);
    const fontsOk = await evaluate(`(async () => {
      const faces = ['100px "Titan One"', '600 16px "Fredoka"', '400 12px "IBM Plex Sans"', '600 12px "IBM Plex Sans"', '500 9px "IBM Plex Mono"'];
      // the stylesheet arrives after navigation; poll until its faces are loaded
      for (let i = 0; i < 150; i++) {
        await Promise.all(faces.map((f) => document.fonts.load(f, "POCKETNXUSabc©")));
        await document.fonts.ready;
        const loaded = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, ""));
        if (["Titan One", "Fredoka", "IBM Plex Sans", "IBM Plex Mono"].every((family) => loaded.includes(family))) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })()`);
    if (!fontsOk) throw new Error("web fonts did not load");
    await evaluate(await Bun.file(ART + "draw.js").text() + "\ntrue");
    const png = async (expr: string) => dataUrlBytes(await evaluate(`(${expr}).toDataURL("image/png")`));

    // -- letters --------------------------------------------------------------
    const s = FS / 100;
    const letters = [];
    for (const [i, l] of WORD.entries()) {
      const face = "face" in l && l.face;
      const g = await evaluate(`NX.glyph(${JSON.stringify(l.ch)}, ${face})`);
      const src = face ? "" : await writePng(`letter-${i}.png`, await png(`NX.letter(${JSON.stringify(l.ch)}, "${l.color}", false, null, ${FS}, ${LETTER_SPRITE})`), LETTER_SPRITE, LETTER_SPRITE);
      const shadow = await writePng(`shadow-${i}.png`, await png(`NX.shadow(${JSON.stringify(l.ch)}, "${l.color}", ${face}, ${FS}, ${LETTER_SPRITE})`), LETTER_SPRITE, LETTER_SPRITE);
      letters.push({ ch: l.ch, src, shadow, w: round(g.w * s), ih: round(g.ih * s), rcK: g.rcK });
    }
    const faces: Record<string, string> = {};
    const o = WORD.findIndex((l) => "face" in l && l.face);
    for (const state of ["open", "shut", "left", "right", "blink", "happy", "wince"]) {
      faces[state] = await writePng(`o-${state}.png`, await png(`NX.letter("O", "${WORD[o].color}", true, "${state}", ${FS}, ${LETTER_SPRITE})`), LETTER_SPRITE, LETTER_SPRITE);
    }
    letters[o].src = faces.open;

    // -- toys -----------------------------------------------------------------
    const toys: Record<string, string> = {};
    for (const type of await evaluate("NX.toys")) {
      toys[type] = await writePng(`toy-${type}.png`, await png(`NX.toy("${type}", ${TOY_R}, ${TOY_SPRITE})`), TOY_SPRITE, TOY_SPRITE);
    }

    // -- particles --------------------------------------------------------------
    const COLORS: Record<string, string> = { y: "#ffd23f", p: "#ff5f9e", c: "#3fd0e8", l: "#a98bff", o: "#ffb45c", i: "#fcf6ff" };
    const particles: Record<string, string[]> = { burst: [], bdot: [], star: [], dot: [] };
    for (const kind of Object.keys(particles)) {
      for (const [key, color] of Object.entries(COLORS)) {
        if ((kind === "star" || kind === "dot") && key === "o") continue;
        particles[kind].push(await writePng(`p-${kind}-${key}.png`, await png(`NX.particle("${kind}", "${color}", ${PARTICLE_SPRITE})`), PARTICLE_SPRITE, PARTICLE_SPRITE));
      }
    }

    // -- the pocket -------------------------------------------------------------
    const pocket = {
      front: await writePng("pocket-front.png", await png(`NX.pocketFront(${POCKET_K}, ${POCKET_LW}, ${POCKET_SPRITE}, ${POCKET_TIP_IN_SPRITE})`), POCKET_SPRITE, POCKET_SPRITE),
      mouth: await writePng("pocket-mouth.png", await png(`NX.pocketMouth(${POCKET_K}, ${POCKET_LW}, 128, 32)`), 128, 32),
      eyes: await writePng("pocket-eyes.png", await png(`NX.pocketEyes(${POCKET_K}, "open", 64, 32)`), 64, 32),
      happy: await writePng("pocket-eyes-happy.png", await png(`NX.pocketEyes(${POCKET_K}, "happy", 64, 32)`), 64, 32),
    };

    // -- the wordmark block, for the backdrop's rays and haze -------------------------
    const rowW = (row: typeof letters) => row.reduce((sum, l) => sum + l.w + LETTER_GAP, -LETTER_GAP);
    const wordW = Math.max(rowW(letters.slice(0, ROW_SPLIT)), rowW(letters.slice(ROW_SPLIT)));
    const rowH = Math.max(...letters.map((l) => l.ih));
    const wordH = rowH * 2 + ROW_GAP;
    const backdrop = {
      top: await writePng("top.png", await png(`NX.topBackdrop(${JSON.stringify({
        w: TOP_W, h: TOP_H, texW: 512, texH: 256, rayX: TOP_W / 2, rayY: BOTTOM_Y + POCKET_TOP_Y, wordY: WORD_TOP + wordH / 2, wordW,
      })})`), 512, 256),
      haze: await writePng("haze.png", await png(`NX.haze(${JSON.stringify({ texW: 512, texH: 256, wordW, wordH })})`), 512, 256),
      bottom: await writePng("bottom.png", await png(`NX.bottomBackdrop(${JSON.stringify({
        w: BOTTOM_W, h: BOTTOM_H, texW: 512, texH: 256, cx: POCKET_CX, topY: POCKET_TOP_Y, pw: POCKET_PW, floorY: FLOOR_Y,
      })})`), 512, 256),
      glow: await writePng("glow.png", await png(`NX.glow(${JSON.stringify({ texW: 256, texH: 128, pw: POCKET_PW })})`), 256, 128),
    };
    const hint = await writePng("hint.png", await png(`NX.hint(128, 64)`), 128, 64);

    // -- typography from the homepage's CSS ------------------------------------------------
    const ledeBox = await evaluate(`(() => {
      const r = document.createRange(); r.selectNodeContents(document.querySelector("#lede p"));
      let l = 1e9, t = 1e9, rr = -1e9, b = -1e9;
      for (const q of r.getClientRects()) { if (q.width < 1) continue; l = Math.min(l, q.left); t = Math.min(t, q.top); rr = Math.max(rr, q.right); b = Math.max(b, q.bottom); }
      return { l, t, r: rr, b };
    })()`);
    const shot = (x: number, y: number, width: number, height: number) => chrome.screenshot({ x, y, width, height });
    const lede = await writePng("lede.png", await shot(0, 0, 512, 64), 512, 64);
    if (ledeBox.b > 64) throw new Error(`the lede needs ${ledeBox.b}px; it must fit 64`);
    const copy = await writePng("copy.png", await shot(0, 100, 128, 16), 128, 16);

    const manifest = `// AUTO-GENERATED by apps/nexus/gen-art.ts — do not edit; run \`bun apps/nexus/gen-art.ts\`.
//
// The baked art of the Pocket Nexus scene. Every image name is a full string
// literal so tools/build.ts bakes it into the pak; the letter metrics are the
// Titan One ink boxes at FS px that the physics bodies are sized from.

export interface LetterArt { ch: string; src: string; shadow: string; w: number; ih: number; rcK: number }

export const LETTER_ART: readonly LetterArt[] = ${JSON.stringify(letters, null, 2)};

export const O_FACE = ${JSON.stringify(faces, null, 2)} as const;

export const TOY_ART = ${JSON.stringify(toys, null, 2)} as const;

export const PARTICLE_ART = ${JSON.stringify(particles, null, 2)} as const;

export const POCKET_ART = ${JSON.stringify(pocket, null, 2)} as const;

export const BACKDROP_ART = ${JSON.stringify(backdrop, null, 2)} as const;

export const HINT_ART = ${JSON.stringify(hint)};
export const COPY_ART = ${JSON.stringify(copy)};
export const LEDE_ART = ${JSON.stringify(lede)};
/** The lede's ink box inside its 512x64 sprite. */
export const LEDE_BOX = ${JSON.stringify({ l: round(ledeBox.l), t: round(ledeBox.t), r: round(ledeBox.r), b: round(ledeBox.b) })};
/** The wordmark block measured from the metrics above. */
export const WORD_BOX = ${JSON.stringify({ w: round(wordW), h: round(wordH), rowH: round(rowH) })};
`;
    await Bun.write(HERE + "art.ts", manifest);
    const images: Record<string, { linear: boolean }> = {};
    for (const key of written) images[key] = { linear: true };
    await Bun.write(HERE + "images.json", JSON.stringify(images, null, 2) + "\n");
    console.log(`nexus: baked ${written.length} images into apps/nexus/art/ (hinge ${HINGE}px, bottom origin ${BOTTOM_X},${BOTTOM_Y})`);
  } finally {
    chrome.stop();
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

await main();
