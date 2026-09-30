// apps/nexus-touch/gen-art.ts — bake the Pocket Nexus touch art from the homepage.
//
//   bun apps/nexus-touch/gen-art.ts
//
// Opens site/nexus/public/index.html in headless Chrome at 320x480 with its
// web chrome hidden (the top bar and the Enter PocketJS button link to other
// sites), so the homepage's own layout() places the wordmark, the lede and
// the hint on the iPod's screen. From that document it measures the layout
// and captures the sky, the lede, the copy line, the hint and the speech
// bubbles at device scale 2; the Nexus canvas art (apps/nexus/bake.ts
// DRAW_JS) and art/draw-touch.js draw the letters, toys, particles and pocket
// at twice their logical size. Every sprite is written as name@2x.png plus a
// box-filtered name.png, both staged through apps/nexus/bake.ts. Smooth
// gradients (the haze and the pop glow) are baked once at low resolution and
// stretched.
//
// art.ts is the manifest the app imports: literal image names for the
// build's image scan, the measured layout, and the glyph metrics the physics
// bodies are sized from. The page loads its fonts from Google Fonts; the PNGs
// are the committed product art, so builds never need the network.

import { HeadlessChrome } from "../../tools/headless-chrome.ts";
import { encodePNG } from "../../tools/png.ts";
import { DRAW_JS, TextureStage, dataUrlBytes, decode, type Rgba } from "../nexus/bake.ts";
import { HOME_Y, LINES, O_LINES, SAYS, WORD } from "../nexus/homepage.ts";
import * as S from "./scene.ts";

const HERE = new URL(".", import.meta.url).pathname;
const ROOT = new URL("../../", import.meta.url).pathname;
const ART = HERE + "art/";
const PORT = 9352;
/** Bake density: the iPod touch 4 presents 320x480 on a 640x960 panel. */
const D = 2;
/** Largest logical texture side at density 2 (the core's 512 px cap). */
const TILE = 256;

const HIDE_CHROME = ".bar,.cta{display:none!important}";

// ---- images -----------------------------------------------------------------------

const pow2 = (n: number) => {
  let p = 8;
  while (p < n) p *= 2;
  return p;
};
const round = (n: number) => Math.round(n * 100) / 100;

/** Box-filter a density-2 image to density 1, averaging in premultiplied alpha. */
function half(image: Rgba): Rgba {
  const w = image.width / 2, h = image.height / 2, src = image.rgba;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const i = ((2 * y + dy) * image.width + 2 * x + dx) * 4, al = src[i + 3];
        r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al;
      }
      const o = (y * w + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round(a / 4);
    }
  }
  return { rgba: out, width: w, height: h };
}

/** A sub-rectangle (device px), padded with transparency past the source edge. */
function crop(image: Rgba, x: number, y: number, w: number, h: number): Rgba {
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= image.height) continue;
    for (let col = 0; col < w; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= image.width) continue;
      out.set(image.rgba.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4), (row * w + col) * 4);
    }
  }
  return { rgba: out, width: w, height: h };
}

const textures = new TextureStage();

/** Stage a density-2 sprite as name@2x.png and its box-filtered name.png;
 *  returns the image key the app names. */
function stage(name: string, image2x: Rgba, w: number, h: number): string {
  if (image2x.width !== w * D || image2x.height !== h * D) {
    throw new Error(`${name}: ${image2x.width}x${image2x.height}, expected ${w * D}x${h * D}`);
  }
  textures.put(`${name}@2x.png`, { ...image2x, rgba: image2x.rgba.slice() });
  textures.put(`${name}.png`, half(image2x));
  return `art/${name}.png`;
}

/** Stage a smooth image at one resolution; the app stretches it. */
function stageFlat(name: string, image: Rgba): string {
  textures.put(`${name}.png`, image);
  return `art/${name}.png`;
}

interface Tile { src: string; x: number; y: number; w: number; h: number }

/** Column cut of a logical `w`-wide strip into at most two textures: at the
 *  emptiest column the texture cap allows, so a cut rarely crosses ink. */
function cutColumns(image2x: Rgba, w: number): number[] {
  if (w <= TILE) return [0, w];
  if (w > 2 * TILE) throw new Error(`strip of ${w} px needs more than two columns`);
  let best = TILE, bestInk = Infinity;
  for (let x = Math.ceil(w - TILE); x <= TILE; x++) {
    let ink = 0;
    for (let y = 0; y < image2x.height; y++) ink += image2x.rgba[(y * image2x.width + x * D) * 4 + 3];
    if (ink < bestInk || (ink === bestInk && Math.abs(x - w / 2) < Math.abs(best - w / 2))) { best = x; bestInk = ink; }
  }
  return [0, best, w];
}

/** Split a density-2 image of logical size (w, h) into power-of-two tiles. */
function tiles(name: string, image2x: Rgba, w: number, h: number, cols = cutColumns(image2x, w), rows = h <= TILE ? [0, h] : [0, TILE, h]): Tile[] {
  const out: Tile[] = [];
  for (let r = 0; r + 1 < rows.length; r++) {
    for (let c = 0; c + 1 < cols.length; c++) {
      const tw = pow2(cols[c + 1] - cols[c]), th = pow2(rows[r + 1] - rows[r]);
      const part = crop(image2x, cols[c] * D, rows[r] * D, tw * D, th * D);
      // pixels past the strip belong to the next tile
      for (let y = 0; y < th * D; y++) {
        for (let x = 0; x < tw * D; x++) {
          if (x >= (cols[c + 1] - cols[c]) * D || y >= (rows[r + 1] - rows[r]) * D) part.rgba.fill(0, (y * tw * D + x) * 4, (y * tw * D + x) * 4 + 4);
        }
      }
      out.push({ src: stage(`${name}-${r}-${c}`, part, tw, th), x: cols[c], y: rows[r], w: tw, h: th });
    }
  }
  return out;
}


// ---- the bake ---------------------------------------------------------------------------

async function main() {
  const chrome = await HeadlessChrome.start({ port: PORT, profile: `${process.env.TMPDIR ?? "/tmp/"}pocketjs-nexus-touch-art`, timeoutMs: 60_000 });
  const evaluate = (expression: string) => chrome.evaluate(expression);
  const canvasPng = async (expr: string): Promise<Rgba> => decode(dataUrlBytes(await evaluate(`(${expr}).toDataURL("image/png")`)));
  /** Viewport region in CSS px, captured at device scale D. */
  const shot = async (x: number, y: number, w: number, h: number): Promise<Rgba> => {
    const image = decode(await chrome.screenshot({ x, y, width: w, height: h }));
    if (image.width !== w * D || image.height !== h * D) throw new Error(`capture ${w}x${h} came back ${image.width}x${image.height}`);
    return image;
  };
  try {
    await chrome.send("Emulation.setDeviceMetricsOverride", { width: S.W, height: S.H, deviceScaleFactor: D, mobile: true });
    await chrome.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    // reduced motion: the page settles its letters at once, with the text shown
    await chrome.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await chrome.send("Page.enable");
    await chrome.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `document.addEventListener("DOMContentLoaded", () => {
        const s = document.createElement("style"); s.textContent = ${JSON.stringify(HIDE_CHROME)}; document.head.appendChild(s);
      });`,
    });
    await chrome.navigate(`file://${ROOT}site/nexus/public/index.html`);
    const fontsOk = await evaluate(`(async () => {
      const faces = ['100px "Titan One"', '600 16px "Fredoka"', '400 16px "IBM Plex Sans"', '600 16px "IBM Plex Sans"', '500 12px "IBM Plex Mono"'];
      for (let i = 0; i < 200; i++) {
        await document.fonts.ready;
        if (faces.every((f) => document.fonts.check(f, "POCKETNXUS"))) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })()`);
    if (!fontsOk) throw new Error("web fonts did not load");
    // the page re-runs layout() on resize; give it the hidden chrome, then a frame
    await evaluate(`new Promise((r) => { window.dispatchEvent(new Event("resize")); setTimeout(r, 400); })`);
    await evaluate((await Bun.file(DRAW_JS).text()) + "\ntrue");
    await evaluate((await Bun.file(ART + "draw-touch.js").text()) + "\ntrue");

    // -- the layout the homepage chose ----------------------------------------------------
    const page = await evaluate(`(() => {
      const box = (el) => { const q = el.getBoundingClientRect(); return { l: q.left, t: q.top, r: q.right, b: q.bottom }; };
      const word = document.querySelector(".word");
      const union = (el) => {
        const rg = document.createRange(); rg.selectNodeContents(el);
        let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
        for (const q of rg.getClientRects()) { if (q.width < 1) continue; l = Math.min(l, q.left); t = Math.min(t, q.top); r = Math.max(r, q.right); b = Math.max(b, q.bottom); }
        return { l, t, r, b };
      };
      return {
        fs: parseFloat(getComputedStyle(word).fontSize),
        oneRow: word.classList.contains("one"),
        slots: [...document.querySelectorAll(".word .ch")].map((el) => { const q = el.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; }),
        lede: union(document.querySelector(".lede")),
        copy: union(document.querySelector(".copy")),
        hintText: box(document.querySelector("#hint b")),
        hintArrow: box(document.querySelector("#hint svg")),
        pocket: box(document.querySelector("#pocket")),
      };
    })()`);
    if (page.oneRow) throw new Error("the homepage chose its one-row wordmark; the scene expects two rows");
    const FS = page.fs, s = FS / 100;
    // the pocket button the page placed must agree with scene.ts's formulas
    const bw = S.POCKET_PW + S.POCKET_LW + 8;
    if (Math.abs(page.pocket.l - (S.POCKET_CX - bw / 2)) > 0.5 || Math.abs(page.pocket.t - (S.POCKET_TOP_Y - S.POCKET_LW / 2 - 4)) > 0.5) {
      throw new Error(`the page's pocket ${JSON.stringify(page.pocket)} disagrees with scene.ts`);
    }

    // -- letters -------------------------------------------------------------------------
    const LS = S.LETTER_SPRITE;
    const letters: { ch: string; src: string; shadow: string; w: number; ih: number; rcK: number; home: [number, number] }[] = [];
    let wl = Infinity, wt = Infinity, wr = -Infinity, wb = -Infinity;
    for (const [i, l] of WORD.entries()) {
      const face = "face" in l && l.face;
      const g = await evaluate(`NX.glyph(${JSON.stringify(l.ch)}, ${face})`);
      const src = stage(face ? "o-body" : `letter-${i}`, await canvasPng(`NX.letter(${JSON.stringify(l.ch)}, "${l.color}", ${face}, null, ${FS * D}, ${LS * D})`), LS, LS);
      const shadow = stage(`shadow-${i}`, await canvasPng(`NX.shadow(${JSON.stringify(l.ch)}, "${l.color}", ${face}, ${FS * D}, ${LS * D})`), LS, LS);
      const [sx, sy] = page.slots[i];
      const home: [number, number] = [round(sx), round(sy + HOME_Y[i] * FS)];
      const w = g.w * s, ih = g.ih * s;
      letters.push({ ch: l.ch, src, shadow, w: round(w), ih: round(ih), rcK: g.rcK, home });
      // the homepage's WM box: each letter's collision box about its home
      const hw = (g.w / 2 + 5) * s, hh = (g.ih / 2 + 5) * s;
      wl = Math.min(wl, home[0] - hw); wr = Math.max(wr, home[0] + hw); wt = Math.min(wt, home[1] - hh); wb = Math.max(wb, home[1] + hh);
    }
    const wm = { l: round(wl), t: round(wt), r: round(wr), b: round(wb), w: round(wr - wl), h: round(wb - wt), cx: round((wl + wr) / 2), cy: round((wt + wb) / 2) };
    const faces: Record<string, string> = {};
    for (const state of ["look", "talk", "happy", "wince", "shut"]) {
      faces[state] = stage(`o-${state}`, await canvasPng(`NXT.oFace("${state}", ${FS * D}, ${LS * D})`), LS, LS);
    }
    const oEyes = await evaluate(`NXT.oEyes(${FS})`);
    const oEye = stage("o-eye", await canvasPng(`NXT.oEye(${FS * D}, ${S.O_EYE_SPRITE * D})`), S.O_EYE_SPRITE, S.O_EYE_SPRITE);

    // -- toys and particles ------------------------------------------------------------------
    const toys: Record<string, string> = {};
    for (const type of await evaluate("NX.toys")) {
      toys[type] = stage(`toy-${type}`, await canvasPng(`NX.toy("${type}", ${S.TOY_R * D}, ${S.TOY_SPRITE * D})`), S.TOY_SPRITE, S.TOY_SPRITE);
    }
    const COLORS: Record<string, string> = { y: "#ffd23f", p: "#ff5f9e", c: "#3fd0e8", l: "#a98bff", o: "#ffb45c", i: "#fcf6ff" };
    const particles: Record<string, string[]> = { burst: [], bdot: [], star: [], dot: [] };
    for (const kind of Object.keys(particles)) {
      for (const [key, color] of Object.entries(COLORS)) {
        if ((kind === "star" || kind === "dot") && key === "o") continue;
        particles[kind].push(stage(`p-${kind}-${key}`, await canvasPng(`NX.particle("${kind}", "${color}", ${S.PARTICLE_SPRITE * D})`), S.PARTICLE_SPRITE, S.PARTICLE_SPRITE));
      }
    }

    // -- the pocket ------------------------------------------------------------------------------
    const k = S.POCKET_K, PW2 = S.POCKET_SPRITE_W * D, PH2 = S.POCKET_SPRITE_H * D;
    // draw.js draws a square frame; crop the band that holds the pocket
    const front = await canvasPng(`(() => {
      const sq = NX.pocketFront(${k * D}, ${S.POCKET_LW * D}, ${PW2}, ${(S.POCKET_TIP_IN_SPRITE + (S.POCKET_SPRITE_W - S.POCKET_SPRITE_H) / 2) * D});
      const c = document.createElement("canvas"); c.width = ${PW2}; c.height = ${PH2};
      c.getContext("2d").drawImage(sq, 0, -${((S.POCKET_SPRITE_W - S.POCKET_SPRITE_H) / 2) * D});
      window.pocketFront = c;
      return c;
    })()`);
    const pocket = {
      front: stage("pocket-front", front, S.POCKET_SPRITE_W, S.POCKET_SPRITE_H),
      mouth: stage("pocket-mouth", await canvasPng(`NX.pocketMouth(${k * D}, ${S.POCKET_LW * D}, ${S.MOUTH_W * D}, ${S.MOUTH_H * D})`), S.MOUTH_W, S.MOUTH_H),
      whites: stage("pocket-whites", await canvasPng(`NXT.pocketEyePart(${k * D}, "whites", ${S.EYES_W * D}, ${S.EYES_H * D})`), S.EYES_W, S.EYES_H),
      pupils: stage("pocket-pupils", await canvasPng(`NXT.pocketEyePart(${k * D}, "pupils", ${S.EYES_W * D}, ${S.EYES_H * D})`), S.EYES_W, S.EYES_H),
      happy: stage("pocket-happy", await canvasPng(`NXT.pocketEyePart(${k * D}, "happy", ${S.EYES_W * D}, ${S.EYES_H * D})`), S.EYES_W, S.EYES_H),
    };
    const glow = stageFlat("glow", await canvasPng(`NX.glow({ texW: 256, texH: 128, pw: ${S.POCKET_PW} })`));
    const hazeBox = { x: 0, y: round(wm.cy - S.W / 2), w: S.W, h: S.W };
    const haze = stageFlat("haze", await canvasPng(`NXT.haze(${JSON.stringify({ texW: 256, texH: 256, bx: hazeBox.x, by: hazeBox.y, bw: hazeBox.w, bh: hazeBox.h, wm })})`));

    // -- the sky: the page's own background, plus drawGlow and drawFloor at rest --------------
    await evaluate(`(() => {
      document.querySelector("#play").style.display = "none";
      for (const sel of [".hero", "#hint", ".copy", "#tags", "#pocket"]) document.querySelector(sel).style.visibility = "hidden";
      const ov = document.createElement("canvas");
      ov.id = "bake-overlay"; ov.width = ${S.W * D}; ov.height = ${S.H * D};
      ov.style.cssText = "position:fixed;left:0;top:0;width:${S.W}px;height:${S.H}px;z-index:1;pointer-events:none";
      document.body.appendChild(ov);
      const ctx = ov.getContext("2d"); ctx.scale(${D}, ${D});
      NXT.glowFloor(ctx, ${JSON.stringify({ cx: S.POCKET_CX, topY: S.POCKET_TOP_Y, pw: S.POCKET_PW, floorY: S.FLOOR_Y, W: S.W, H: S.H, wm })});
      return true;
    })()`);
    const sky = await shot(0, 0, S.W, S.H);
    const backdrop = tiles("sky", sky, S.W, S.H, [0, TILE, S.W], [0, TILE, S.H]);
    // the launch image is the app's first frame: the sky and the pocket at rest
    await evaluate(`(() => {
      const ctx = document.querySelector("#bake-overlay").getContext("2d");
      const mouthY = ${S.POCKET_TIP_Y - 15 * S.POCKET_K};
      ctx.save(); ctx.translate(${S.POCKET_CX}, mouthY); ctx.scale(1, ${S.MOUTH_REST});
      ctx.drawImage(NX.pocketMouth(${k * D}, ${S.POCKET_LW * D}, ${S.MOUTH_W * D}, ${S.MOUTH_H * D}), ${-S.MOUTH_W / 2}, ${-S.MOUTH_H / 2}, ${S.MOUTH_W}, ${S.MOUTH_H});
      ctx.restore();
      ctx.drawImage(pocketFront, ${S.POCKET_CX - S.POCKET_SPRITE_W / 2}, ${S.POCKET_TIP_Y - S.POCKET_TIP_IN_SPRITE}, ${S.POCKET_SPRITE_W}, ${S.POCKET_SPRITE_H});
      return true;
    })()`);
    const launch = await shot(0, 0, S.W, S.H);

    // -- text: the lede, the copy line and the hint on a transparent page -------------------------
    await evaluate(`(() => {
      document.querySelector("#bake-overlay").remove();
      const s = document.createElement("style");
      s.textContent = "html,body{background:transparent!important}.sky{display:none!important}.word{visibility:hidden!important}";
      document.head.appendChild(s);
      document.querySelector(".hero").style.visibility = "visible";
      return true;
    })()`);
    const pad = (b: { l: number; t: number; r: number; b: number }, x: number, top: number, bottom: number) =>
      ({ l: Math.floor(b.l - x), t: Math.floor(b.t - top), r: Math.ceil(b.r + x), b: Math.ceil(b.b + bottom) });
    const ledeBox = pad(page.lede, 3, 2, 4);
    const ledeImage = await shot(ledeBox.l, ledeBox.t, ledeBox.r - ledeBox.l, ledeBox.b - ledeBox.t);
    const lede = {
      x: ledeBox.l, y: ledeBox.t, w: ledeBox.r - ledeBox.l, h: ledeBox.b - ledeBox.t,
      /** The text's ink box in screen px (the shelf the toys bonk). */
      ink: { l: round(page.lede.l), t: round(page.lede.t), r: round(page.lede.r), b: round(page.lede.b) },
      tiles: tiles("lede", ledeImage, ledeBox.r - ledeBox.l, ledeBox.b - ledeBox.t),
    };
    await evaluate(`(() => { document.querySelector(".hero").style.visibility = "hidden"; document.querySelector(".copy").style.visibility = "visible"; return true; })()`);
    const copyBox = pad(page.copy, 2, 2, 2);
    const copyTiles = tiles("copy", await shot(copyBox.l, copyBox.t, copyBox.r - copyBox.l, copyBox.b - copyBox.t), copyBox.r - copyBox.l, copyBox.b - copyBox.t);
    if (copyTiles.length !== 1) throw new Error("the copy line should fit one texture");
    const copy = { ...copyTiles[0], x: copyBox.l, y: copyBox.t };
    await evaluate(`(() => {
      document.querySelector(".copy").style.visibility = "hidden";
      const hint = document.querySelector("#hint"); hint.classList.add("on"); hint.style.visibility = "visible";
      hint.querySelector("svg").style.visibility = "hidden";
      return true;
    })()`);
    const hintTextBox = pad(page.hintText, 4, 4, 5);
    const hintText = tiles("hint-text", await shot(hintTextBox.l, hintTextBox.t, hintTextBox.r - hintTextBox.l, hintTextBox.b - hintTextBox.t), hintTextBox.r - hintTextBox.l, hintTextBox.b - hintTextBox.t)[0];
    await evaluate(`(() => { const hint = document.querySelector("#hint"); hint.querySelector("b").style.visibility = "hidden"; hint.querySelector("svg").style.visibility = "visible"; return true; })()`);
    const arrowBox = pad(page.hintArrow, 3, 3, 3);
    const hintArrow = tiles("hint-arrow", await shot(arrowBox.l, arrowBox.t, arrowBox.r - arrowBox.l, arrowBox.b - arrowBox.t), arrowBox.r - arrowBox.l, arrowBox.b - arrowBox.t)[0];
    const hint = { text: { ...hintText, x: hintTextBox.l, y: hintTextBox.t }, arrow: { ...hintArrow, x: arrowBox.l, y: arrowBox.t } };
    await evaluate(`(() => { document.querySelector("#hint").style.visibility = "hidden"; return true; })()`);

    // -- speech bubbles: the homepage's .tag elements, anchored at a known point --------------------
    interface TagArt { src: string; w: number; h: number; px: number; py: number }
    const AX = 160, AY = 240;
    const bubble = async (name: string, kind: string, text: string): Promise<TagArt> => {
      const b = await evaluate(`(() => {
        const tags = document.querySelector("#tags");
        tags.textContent = ""; tags.style.visibility = "visible";
        const el = document.createElement("div"); el.className = "tag ${kind} in";
        const b = document.createElement("b"); b.textContent = ${JSON.stringify(text)}; el.appendChild(b);
        el.style.transform = "translate3d(${AX}px,${AY}px,0)";
        tags.appendChild(el);
        const q = b.getBoundingClientRect();
        return { l: q.left, t: q.top, r: q.right, b: q.bottom };
      })()`);
      // the tail reaches 8 px past the bubble toward the anchor, its shadow 4 px down
      const ink = { l: b.l - 3, t: b.t - 3, r: b.r + 3, b: b.b + 6 };
      if (kind.includes("perch-r")) ink.l = Math.min(ink.l, AX - 3);
      else if (kind.includes("perch-l")) ink.r = Math.max(ink.r, AX + 3);
      else ink.b = Math.max(ink.b, AY + 11);
      const w = pow2(ink.r - ink.l), h = pow2(ink.b - ink.t);
      // the anchor keeps its place in the sprite: pad the far side
      let x0: number, y0: number;
      if (kind.includes("perch-r")) { x0 = Math.floor(ink.l); y0 = Math.round(AY - h / 2); }
      else if (kind.includes("perch-l")) { x0 = Math.ceil(ink.r) - w; y0 = Math.round(AY - h / 2); }
      else { x0 = Math.round(AX - w / 2); y0 = Math.ceil(ink.b) - h; }
      if (ink.l < x0 || ink.r > x0 + w || ink.t < y0 || ink.b > y0 + h) throw new Error(`${name}: bubble ${JSON.stringify(ink)} does not fit ${w}x${h} at ${x0},${y0}`);
      const src = stage(name, await shot(x0, y0, w, h), w, h);
      return { src, w, h, px: AX - x0, py: AY - y0 };
    };
    const lines = [...new Set<string>([...LINES, ...O_LINES, ...SAYS])];
    const slug = (text: string) => text.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "") || "q";
    const tags = {
      pjs: await bubble("tag-pjs", "pjs", "PocketJS"),
      say: {} as Record<string, TagArt>,
      perchR: {} as Record<string, TagArt>,
      perchL: {} as Record<string, TagArt>,
    };
    for (const text of lines) {
      tags.say[text] = await bubble(`say-${slug(text)}`, "say", text);
      tags.perchR[text] = await bubble(`say-${slug(text)}-r`, "say perch-r", text);
      tags.perchL[text] = await bubble(`say-${slug(text)}-l`, "say perch-l", text);
    }

    const json = (value: unknown) => JSON.stringify(value, null, 2);
    const manifest = `// AUTO-GENERATED by apps/nexus-touch/gen-art.ts — do not edit; run \`bun apps/nexus-touch/gen-art.ts\`.
//
// The baked art of the Pocket Nexus touch scene and the layout the homepage
// chose for a 320x480 screen. Every image name is a full string literal so
// tools/build.ts bakes it into the pak; the letter metrics are the Titan One
// ink boxes at FS px that the physics bodies are sized from.

export interface LetterArt { ch: string; src: string; shadow: string; w: number; ih: number; rcK: number; home: readonly [number, number] }
export interface Tile { src: string; x: number; y: number; w: number; h: number }
export interface TagArt { src: string; w: number; h: number; px: number; py: number }

/** The wordmark's font size: the homepage's fitHero() at 320x480. */
export const FS = ${FS};

export const LETTER_ART: readonly LetterArt[] = ${json(letters)};

/** The O's face layers over its plain sticker; the eyes are separate nodes. */
export const O_FACE = ${json(faces)} as const;
export const O_EYE = ${JSON.stringify(oEye)};
/** Eye centres from the O's centre, px. */
export const O_EYES = ${JSON.stringify({ ex: round(oEyes.ex), ey: round(oEyes.ey) })};

export const TOY_ART = ${json(toys)} as const;

export const PARTICLE_ART = ${json(particles)} as const;

export const POCKET_ART = ${json(pocket)} as const;

export const SKY_TILES: readonly Tile[] = ${json(backdrop)};
export const HAZE_ART = ${JSON.stringify(haze)};
export const HAZE_BOX = ${JSON.stringify(hazeBox)};
export const GLOW_ART = ${JSON.stringify(glow)};

/** The lede at its homepage position; \`ink\` is the text's box. */
export const LEDE = ${json(lede)};
export const COPY: Tile = ${JSON.stringify(copy)};
export const HINT = ${json(hint)};

/** Speech bubbles; (px, py) is the anchor the tail points at. */
export const TAG_ART = ${json(tags)};
`;
    // every sprite rendered and checked: replace the art, its manifest and filters together
    await textures.write(ART);
    await Bun.write(HERE + "launch.png", encodePNG(launch.rgba, launch.width, launch.height));
    await Bun.write(HERE + "art.ts", manifest);
    const images: Record<string, { linear: boolean }> = {};
    for (const name of textures.files.keys()) if (!name.includes("@")) images[`art/${name}`] = { linear: true };
    await Bun.write(HERE + "images.json", JSON.stringify(images, null, 2) + "\n");
    console.log(`nexus-touch: baked ${textures.files.size} textures into apps/nexus-touch/art/ (wordmark ${FS}px)`);
  } finally {
    chrome.stop();
  }
}

await main();
