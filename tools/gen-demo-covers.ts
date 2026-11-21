// tools/gen-demo-covers.ts — bake XMB cover art for the showcase demos.
//
// Follows the pocket app-family cover convention (apps/im/psp/gen-cover.ts is
// the single-app reference): ICON0 is a 144×80 brand tile drawn from geometry
// — one shared family layout with a per-demo mark and accent — and PIC1 is a
// 480×272 frame of the real app, pumped through the sim host by the same
// runScenario the golden suites use, dimmed left-heavy so the XMB column
// stays legible. Writes apps/<demo>/psp/{Psp.toml,icon0.png,pic1.png};
// tools/psp.ts picks the fragment up for EVERY framework build of the demo.
//
// --framework=<fw> bakes a VARIANT set into apps/<demo>/psp/<fw>/ instead:
// same layout, plus the framework's name on the tile, in the PIC1 corner and
// in the XMB title, so a demo's framework twins are distinguishable on a
// memory stick that holds several of them. tools/psp.ts prefers the variant
// directory when building that framework.
//
//   bun tools/gen-demo-covers.ts                      (all demos, default fw)
//   bun tools/gen-demo-covers.ts hero music           (a subset)
//   bun tools/gen-demo-covers.ts --framework=octane   (the Octane twins)

import { createCanvas, GlobalFonts, type SKRSContext2D } from "@napi-rs/canvas";
import { mkdirSync } from "node:fs";
import { runScenario } from "../programs/sim/sim.ts";
import { BTN } from "../contracts/spec/spec.ts";
import { FRAMEWORKS, parseFramework } from "../framework/compiler/jsx-plugin.ts";

const ROOT = new URL("../", import.meta.url).pathname;
GlobalFonts.registerFromPath(ROOT + "assets/fonts/Inter-Bold.ttf", "Inter");

interface DemoCover {
  dir: string;
  bundle: string;
  title: string;
  /** Two-line wordmark next to the mark. */
  word: [string, string];
  accent: string;
  /** Seconds of sim time before the PIC1 screenshot. */
  seconds: number;
  script?: { at: number; press: number }[];
  mark: (g: SKRSContext2D) => void;
}

function roundRect(g: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const DEMOS: DemoCover[] = [
  {
    dir: "hero",
    bundle: "hero-main",
    title: "PocketJS Hero",
    word: ["POCKET", "HERO"],
    accent: "#3b82f6",
    seconds: 2.0,
    script: [{ at: 1.5, press: BTN.CIRCLE }],
    mark: (g) => {
      roundRect(g, 14, 20, 40, 40, 10);
      g.fillStyle = "#3b82f6";
      g.fill();
      g.fillStyle = "#f8fafc";
      g.beginPath();
      g.moveTo(29, 30);
      g.lineTo(29, 50);
      g.lineTo(46, 40);
      g.closePath();
      g.fill();
    },
  },
  {
    dir: "cards",
    bundle: "cards-main",
    title: "PocketJS Cards",
    word: ["POCKET", "CARDS"],
    accent: "#818cf8",
    seconds: 1.6,
    mark: (g) => {
      roundRect(g, 24, 24, 30, 38, 6);
      g.fillStyle = "#312e81";
      g.fill();
      roundRect(g, 14, 18, 30, 38, 6);
      g.fillStyle = "#818cf8";
      g.fill();
      g.fillStyle = "#e0e7ff";
      g.fillRect(20, 26, 18, 3);
      g.fillRect(20, 33, 12, 3);
    },
  },
  {
    dir: "stats",
    bundle: "stats-main",
    title: "PocketJS Stats",
    word: ["POCKET", "STATS"],
    accent: "#10b981",
    seconds: 1.8,
    mark: (g) => {
      g.fillStyle = "#155e46";
      roundRect(g, 14, 42, 9, 18, 2.5);
      g.fill();
      g.fillStyle = "#10b981";
      roundRect(g, 27, 32, 9, 28, 2.5);
      g.fill();
      g.fillStyle = "#34d399";
      roundRect(g, 40, 20, 9, 40, 2.5);
      g.fill();
    },
  },
  {
    dir: "library",
    bundle: "library-main",
    title: "PocketJS Library",
    word: ["POCKET", "LIBRARY"],
    accent: "#38bdf8",
    seconds: 1.5,
    mark: (g) => {
      const tiles: [number, number, string][] = [
        [14, 20, "#38bdf8"],
        [36, 20, "#e0507a"],
        [14, 42, "#0ea5b7"],
        [36, 42, "#8b5cf6"],
      ];
      for (const [x, y, fill] of tiles) {
        roundRect(g, x, y, 18, 18, 5);
        g.fillStyle = fill;
        g.fill();
      }
    },
  },
  {
    dir: "settings",
    bundle: "settings-main",
    title: "PocketJS Settings",
    word: ["POCKET", "SETTINGS"],
    accent: "#60a5fa",
    seconds: 1.5,
    mark: (g) => {
      roundRect(g, 14, 26, 44, 12, 6);
      g.fillStyle = "#1e3a5f";
      g.fill();
      g.beginPath();
      g.arc(48, 32, 9, 0, Math.PI * 2);
      g.fillStyle = "#60a5fa";
      g.fill();
      roundRect(g, 14, 46, 44, 12, 6);
      g.fillStyle = "#1e3a5f";
      g.fill();
      g.beginPath();
      g.arc(24, 52, 9, 0, Math.PI * 2);
      g.fillStyle = "#475569";
      g.fill();
    },
  },
  {
    dir: "notifications",
    bundle: "notifications-main",
    title: "PocketJS Notifications",
    word: ["POCKET", "ALERTS"],
    accent: "#f59e0b",
    seconds: 1.2,
    mark: (g) => {
      for (const [y, w, fill] of [
        [20, 40, "#f59e0b"],
        [36, 34, "#eab308"],
        [52, 28, "#a16207"],
      ] as const) {
        roundRect(g, 14, y, w, 11, 4);
        g.fillStyle = fill;
        g.fill();
      }
      g.beginPath();
      g.arc(56, 24, 5, 0, Math.PI * 2);
      g.fillStyle = "#ef4444";
      g.fill();
    },
  },
  {
    dir: "music",
    bundle: "music-main",
    title: "PocketJS Music",
    word: ["POCKET", "MUSIC"],
    accent: "#34d399",
    seconds: 1.5,
    mark: (g) => {
      for (const [i, h] of [26, 40, 18, 32].entries()) {
        roundRect(g, 16 + i * 11, 60 - h, 7, h, 3);
        g.fillStyle = i % 2 ? "#10b981" : "#34d399";
        g.fill();
      }
    },
  },
  {
    dir: "gallery",
    bundle: "gallery-main",
    title: "PocketJS Gallery",
    word: ["POCKET", "GALLERY"],
    accent: "#22d3ee",
    seconds: 1.5,
    mark: (g) => {
      roundRect(g, 14, 20, 44, 40, 7);
      g.fillStyle = "#164e63";
      g.fill();
      g.beginPath();
      g.arc(28, 33, 6, 0, Math.PI * 2);
      g.fillStyle = "#fde68a";
      g.fill();
      g.beginPath();
      g.moveTo(18, 56);
      g.lineTo(34, 38);
      g.lineTo(44, 50);
      g.lineTo(52, 42);
      g.lineTo(56, 56);
      g.closePath();
      g.fillStyle = "#22d3ee";
      g.fill();
    },
  },
];

const args = Bun.argv.slice(2);
const frameworkArg = args.find((a) => a.startsWith("--framework="));
// No flag = the shared, framework-neutral cover set the default build uses.
const framework = frameworkArg
  ? parseFramework(frameworkArg.slice("--framework=".length), "--framework")
  : null;
const frameworkLabel = framework === null ? null : FRAMEWORKS[framework].label;
const only = new Set(args.filter((a) => !a.startsWith("--")));
const selected = only.size === 0 ? DEMOS : DEMOS.filter((d) => only.has(d.dir));
if (selected.length === 0) throw new Error(`no demos match: ${[...only].join(", ")}`);

for (const demo of selected) {
  const out =
    framework === null
      ? `${ROOT}apps/${demo.dir}/psp/`
      : `${ROOT}apps/${demo.dir}/psp/${framework}/`;
  mkdirSync(out, { recursive: true });

  // ICON0 — 144×80 family tile: mark left, two-line wordmark right, accent rule.
  {
    const c = createCanvas(144, 80);
    const g = c.getContext("2d");
    roundRect(g, 0.5, 0.5, 143, 79, 10);
    g.fillStyle = "#0a1118";
    g.fill();
    g.strokeStyle = "#22333f";
    g.lineWidth = 1;
    g.stroke();
    demo.mark(g);
    g.fillStyle = "#e8f0f2";
    g.font = "bold 15px Inter";
    g.fillText(demo.word[0], 66, 36);
    g.fillText(demo.word[1], 66, 55);
    g.fillStyle = demo.accent;
    g.fillRect(67, 61, 26, 2);
    if (frameworkLabel !== null) {
      // The whole point of the variant set: name the framework on the tile so
      // two builds of one demo are not the same icon in the XMB.
      g.font = "bold 10px Inter";
      g.fillText(frameworkLabel.toUpperCase(), 67, 75);
    }
    await Bun.write(out + "icon0.png", c.toBuffer("image/png"));
  }

  // PIC1 — a real frame of the demo via the sim pump the goldens use.
  {
    const trace = await runScenario({
      app: framework === null ? demo.bundle : demo.bundle + FRAMEWORKS[framework].outputSuffix,
      hz: 60,
      seconds: demo.seconds,
      script: demo.script,
    });
    const c = createCanvas(480, 272);
    const g = c.getContext("2d");
    const img = g.createImageData(480, 272);
    img.data.set(trace.finalFrame);
    g.putImageData(img, 0, 0);
    g.fillStyle = "rgba(0,0,0,0.30)";
    g.fillRect(0, 0, 480, 272);
    const grad = g.createLinearGradient(0, 0, 480, 0);
    grad.addColorStop(0, "rgba(0,0,0,0.45)");
    grad.addColorStop(0.55, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 480, 272);
    if (frameworkLabel !== null) {
      // Bottom-right, clear of the XMB's left column and its bottom text row.
      const text = frameworkLabel.toUpperCase();
      g.font = "bold 13px Inter";
      const w = g.measureText(text).width;
      roundRect(g, 480 - 22 - w - 20, 272 - 46, w + 20, 24, 12);
      g.fillStyle = "rgba(8,14,20,0.72)";
      g.fill();
      g.strokeStyle = demo.accent;
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = demo.accent;
      g.fillText(text, 480 - 22 - w - 10, 272 - 29);
    }
    await Bun.write(out + "pic1.png", c.toBuffer("image/png"));
  }

  const title = frameworkLabel === null ? demo.title : `${demo.title} (${frameworkLabel})`;
  const scope =
    framework === null
      ? "when building this demo (any framework)"
      : `when building this demo with --framework=${framework}`;
  const regen =
    framework === null
      ? `bun tools/gen-demo-covers.ts ${demo.dir}`
      : `bun tools/gen-demo-covers.ts --framework=${framework} ${demo.dir}`;
  const toml = `# XMB metadata for the ${title} EBOOT. tools/psp.ts copies this to
# programs/psp/Psp.toml ${scope}; cargo-psp packs
# it into PARAM.SFO / ICON0 / PIC1.
# Regenerate the art with: ${regen}
title = "${title}"
xmb_icon_png = "icon0.png"
xmb_background_png = "pic1.png"
`;
  await Bun.write(out + "Psp.toml", toml);
  console.log(
    `covers: ${out.slice(ROOT.length)} (icon0 144x80, pic1 480x272, "${title}")`,
  );
}
