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

import { HeadlessChrome } from "../../tools/headless-chrome.ts";
import { DRAW_JS, TextureStage, dataUrlBytes, decode } from "./bake.ts";
import { ROW_SPLIT, WORD } from "./homepage.ts";
import {
  FS, LETTER_SPRITE, POCKET_K, POCKET_LW, POCKET_PW, POCKET_SPRITE, POCKET_TIP_IN_SPRITE, POCKET_CX, POCKET_TOP_Y,
  FLOOR_Y, BOTTOM_W, BOTTOM_H, TOP_W, TOP_H, TOY_R, TOY_SPRITE, PARTICLE_SPRITE, LETTER_GAP, ROW_GAP,
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

const textures = new TextureStage();

/** Check one sprite's size and stage it; returns its image key. */
function stage(name: string, bytes: Uint8Array, expectW: number, expectH: number): string {
  const image = decode(bytes);
  if (image.width !== expectW || image.height !== expectH) throw new Error(`${name}: ${image.width}x${image.height}, expected ${expectW}x${expectH}`);
  textures.put(name, image);
  return `art/${name}`;
}

/** A text block's ink box must be measured and fit its sprite. */
function checkInk(name: string, box: { l: number; t: number; r: number; b: number }, w: number, h: number): void {
  const finite = [box.l, box.t, box.r, box.b].every(Number.isFinite) && box.r > box.l && box.b > box.t;
  if (!finite || box.l < 0 || box.t < 0 || box.r > w || box.b > h) {
    throw new Error(`${name}: ink box ${JSON.stringify(box)} does not fit ${w}x${h}`);
  }
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
        if (faces.every((f) => document.fonts.check(f, "POCKETNXUSabc©"))) {
          const loaded = [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family.replace(/"/g, "") + " " + f.weight);
          const want = ["Titan One 400", "Fredoka 600", "IBM Plex Sans 400", "IBM Plex Sans 600", "IBM Plex Mono 500"];
          if (want.every((face) => loaded.includes(face))) return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })()`);
    if (!fontsOk) throw new Error("web fonts did not load");
    await evaluate(await Bun.file(DRAW_JS).text() + "\ntrue");
    const png = async (expr: string) => dataUrlBytes(await evaluate(`(${expr}).toDataURL("image/png")`));

    // -- letters --------------------------------------------------------------
    const s = FS / 100;
    const letters: { ch: string; src: string; shadow: string; w: number; ih: number; rcK: number }[] = [];
    for (const [i, l] of WORD.entries()) {
      const face = "face" in l && l.face;
      const g = await evaluate(`NX.glyph(${JSON.stringify(l.ch)}, ${face})`);
      const src = face ? "" : stage(`letter-${i}.png`, await png(`NX.letter(${JSON.stringify(l.ch)}, "${l.color}", false, null, ${FS}, ${LETTER_SPRITE})`), LETTER_SPRITE, LETTER_SPRITE);
      const shadow = stage(`shadow-${i}.png`, await png(`NX.shadow(${JSON.stringify(l.ch)}, "${l.color}", ${face}, ${FS}, ${LETTER_SPRITE})`), LETTER_SPRITE, LETTER_SPRITE);
      letters.push({ ch: l.ch, src, shadow, w: round(g.w * s), ih: round(g.ih * s), rcK: g.rcK });
    }
    const faces: Record<string, string> = {};
    const o = WORD.findIndex((l) => "face" in l && l.face);
    for (const state of ["open", "shut", "left", "right", "blink", "happy", "wince"]) {
      faces[state] = stage(`o-${state}.png`, await png(`NX.letter("O", "${WORD[o].color}", true, "${state}", ${FS}, ${LETTER_SPRITE})`), LETTER_SPRITE, LETTER_SPRITE);
    }
    letters[o].src = faces.open;

    // -- toys -----------------------------------------------------------------
    const toys: Record<string, string> = {};
    for (const type of await evaluate("NX.toys")) {
      toys[type] = stage(`toy-${type}.png`, await png(`NX.toy("${type}", ${TOY_R}, ${TOY_SPRITE})`), TOY_SPRITE, TOY_SPRITE);
    }

    // -- particles --------------------------------------------------------------
    const COLORS: Record<string, string> = { y: "#ffd23f", p: "#ff5f9e", c: "#3fd0e8", l: "#a98bff", o: "#ffb45c", i: "#fcf6ff" };
    const particles: Record<string, string[]> = { burst: [], bdot: [], star: [], dot: [] };
    for (const kind of Object.keys(particles)) {
      for (const [key, color] of Object.entries(COLORS)) {
        if ((kind === "star" || kind === "dot") && key === "o") continue;
        particles[kind].push(stage(`p-${kind}-${key}.png`, await png(`NX.particle("${kind}", "${color}", ${PARTICLE_SPRITE})`), PARTICLE_SPRITE, PARTICLE_SPRITE));
      }
    }

    // -- the pocket -------------------------------------------------------------
    const pocket = {
      front: stage("pocket-front.png", await png(`NX.pocketFront(${POCKET_K}, ${POCKET_LW}, ${POCKET_SPRITE}, ${POCKET_TIP_IN_SPRITE})`), POCKET_SPRITE, POCKET_SPRITE),
      mouth: stage("pocket-mouth.png", await png(`NX.pocketMouth(${POCKET_K}, ${POCKET_LW}, 128, 32)`), 128, 32),
      eyes: stage("pocket-eyes.png", await png(`NX.pocketEyes(${POCKET_K}, "open", 64, 32)`), 64, 32),
      happy: stage("pocket-eyes-happy.png", await png(`NX.pocketEyes(${POCKET_K}, "happy", 64, 32)`), 64, 32),
    };

    // -- the wordmark block, for the backdrop's rays and haze -------------------------
    const rowW = (row: typeof letters) => row.reduce((sum, l) => sum + l.w + LETTER_GAP, -LETTER_GAP);
    const wordW = Math.max(rowW(letters.slice(0, ROW_SPLIT)), rowW(letters.slice(ROW_SPLIT)));
    const rowH = Math.max(...letters.map((l) => l.ih));
    const wordH = rowH * 2 + ROW_GAP;
    const backdrop = {
      top: stage("top.png", await png(`NX.topBackdrop(${JSON.stringify({
        w: TOP_W, h: TOP_H, texW: 512, texH: 256, rayX: TOP_W / 2, rayY: BOTTOM_Y + POCKET_TOP_Y, wordY: WORD_TOP + wordH / 2, wordW,
      })})`), 512, 256),
      haze: stage("haze.png", await png(`NX.haze(${JSON.stringify({ texW: 512, texH: 256, wordW, wordH })})`), 512, 256),
      bottom: stage("bottom.png", await png(`NX.bottomBackdrop(${JSON.stringify({
        w: BOTTOM_W, h: BOTTOM_H, texW: 512, texH: 256, cx: POCKET_CX, topY: POCKET_TOP_Y, pw: POCKET_PW, floorY: FLOOR_Y,
      })})`), 512, 256),
      glow: stage("glow.png", await png(`NX.glow(${JSON.stringify({ texW: 256, texH: 128, pw: POCKET_PW })})`), 256, 128),
    };
    const hint = stage("hint.png", await png(`NX.hint(128, 64)`), 128, 64);

    // -- typography from the homepage's CSS ------------------------------------------------
    const ink = (selector: string) => evaluate(`(() => {
      const r = document.createRange(); r.selectNodeContents(document.querySelector(${JSON.stringify(selector)}));
      let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity;
      for (const q of r.getClientRects()) { if (q.width < 1) continue; l = Math.min(l, q.left); t = Math.min(t, q.top); rr = Math.max(rr, q.right); b = Math.max(b, q.bottom); }
      return { l, t, r: rr, b };
    })()`);
    const ledeBox = await ink("#lede p");
    checkInk("lede.png", ledeBox, 512, 64);
    const copyBox = await ink("#copy");
    checkInk("copy.png", { ...copyBox, t: copyBox.t - 100, b: copyBox.b - 100 }, 128, 16);
    const shot = (x: number, y: number, width: number, height: number) => chrome.screenshot({ x, y, width, height });
    const lede = stage("lede.png", await shot(0, 0, 512, 64), 512, 64);
    const copy = stage("copy.png", await shot(0, 100, 128, 16), 128, 16);

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
    // every sprite rendered and checked: write the art, its manifest and filters together
    await textures.write(ART);
    await Bun.write(HERE + "art.ts", manifest);
    const images: Record<string, { linear: boolean }> = {};
    for (const name of textures.files.keys()) images[`art/${name}`] = { linear: true };
    await Bun.write(HERE + "images.json", JSON.stringify(images, null, 2) + "\n");
    console.log(`nexus: baked ${textures.files.size} images into apps/nexus/art/ (hinge ${HINGE}px, bottom origin ${BOTTOM_X},${BOTTOM_Y})`);
  } finally {
    chrome.stop();
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

await main();
