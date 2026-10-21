// apps/im/psp/gen-cover.ts — bake Pocket Talk's XMB cover art.
//
// Follows the pocket app-family cover convention: ICON0 is the product's
// brand mark drawn from geometry (a lime typing bubble + wordmark on a dark
// tile), PIC1 is rendered from the app's own content — the sim host boots
// the real bundle, opens MAYA CHEN's thread, and screenshots it, with a dark
// left-weighted overlay so the XMB column stays legible on top.
//
//   bun apps/im/psp/gen-cover.ts     (rewrites icon0.png + pic1.png here)

import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { runScenario } from "../../../programs/sim/sim.ts";
import { BTN } from "../../../contracts/spec/spec.ts";

const ROOT = new URL("../../../", import.meta.url).pathname;
const OUT = new URL("./", import.meta.url).pathname;

GlobalFonts.registerFromPath(ROOT + "assets/fonts/Inter-Bold.ttf", "Inter");

function roundRect(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---------------------------------------------------------------------------
// ICON0 — 144×80 XMB tile
// ---------------------------------------------------------------------------
{
  const W = 144;
  const H = 80;
  const c = createCanvas(W, H);
  const g = c.getContext("2d");

  // Dark tile with a hairline border (matches the app's surface palette).
  roundRect(g, 0.5, 0.5, W - 1, H - 1, 10);
  g.fillStyle = "#0a1118";
  g.fill();
  g.strokeStyle = "#22333f";
  g.lineWidth = 1;
  g.stroke();

  // The mark: a lime chat bubble, tail bottom-left, typing dots inside.
  g.fillStyle = "#b8f34a";
  roundRect(g, 12, 18, 44, 30, 10);
  g.fill();
  g.beginPath(); // tail
  g.moveTo(20, 46);
  g.lineTo(12, 58);
  g.lineTo(31, 48);
  g.closePath();
  g.fill();
  g.fillStyle = "#0c1408";
  for (const cx of [24, 34, 44]) {
    g.beginPath();
    g.arc(cx, 33, 3.2, 0, Math.PI * 2);
    g.fill();
  }

  // Wordmark + the masthead's lime underline.
  g.fillStyle = "#e8f0f2";
  g.font = "bold 17px Inter";
  g.fillText("POCKET", 66, 36);
  g.fillText("TALK", 66, 55);
  g.fillStyle = "#b8f34a";
  g.fillRect(67, 61, 26, 2);

  await Bun.write(OUT + "icon0.png", c.toBuffer("image/png"));
  console.log("wrote icon0.png (144x80)");
}

// ---------------------------------------------------------------------------
// PIC1 — 480×272 XMB background, screenshotted from the running app
// ---------------------------------------------------------------------------
{
  // Boot (bootstrap lands at f30), open MAYA CHEN at f60, settle at the
  // thread bottom — wrapped bubbles + read ticks, the app's signature frame.
  // runScenario is the same pump every sim test uses, so the cover is a frame
  // of the exact world the goldens verify.
  const trace = await runScenario({
    app: "im-main",
    hz: 60,
    seconds: 110 / 60,
    script: [{ at: 1.0, press: BTN.CIRCLE }],
  });
  const rgba = trace.finalFrame;

  const c = createCanvas(480, 272);
  const g = c.getContext("2d");
  const img = g.createImageData(480, 272);
  img.data.set(rgba);
  g.putImageData(img, 0, 0);
  // Legibility: a flat dim plus a stronger left-edge falloff where the XMB
  // draws its column of text.
  g.fillStyle = "rgba(0,0,0,0.30)";
  g.fillRect(0, 0, 480, 272);
  const grad = g.createLinearGradient(0, 0, 480, 0);
  grad.addColorStop(0, "rgba(0,0,0,0.45)");
  grad.addColorStop(0.55, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 480, 272);

  await Bun.write(OUT + "pic1.png", c.toBuffer("image/png"));
  console.log("wrote pic1.png (480x272)");
}
