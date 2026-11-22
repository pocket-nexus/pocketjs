// Shared attribution tooling for committed Motion Lab captures. The opaque
// badge makes the author credit legible on every frame and lets this script
// validate the credited region after GIF palette optimization.

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SITE = new URL(".", import.meta.url).pathname;
const ROOT = SITE + "../";
const FONT = ROOT + "assets/fonts/Inter-Bold.ttf";
const CREDIT = "(yui540)";
const CREDIT_MARKER = "PocketJS Motion Lab credit: (yui540)";

if (!GlobalFonts.registerFromPath(FONT, "Inter")) {
  throw new Error(`motion credit: could not register ${FONT}`);
}

export type MotionCreditBadge = "small" | "large";

type BadgeSpec = {
  width: number;
  height: number;
  fontSize: number;
};

const BADGES: Record<MotionCreditBadge, BadgeSpec> = {
  small: { width: 52, height: 14, fontSize: 8 },
  large: { width: 64, height: 16, fontSize: 10 },
};

export type MotionCreditAsset = {
  path: string;
  width: number;
  height: number;
  badge: MotionCreditBadge;
  gravity: "northeast" | "southeast";
  offsetX: number;
  offsetY: number;
};

export const MOTION_CREDIT_ASSETS: readonly MotionCreditAsset[] = [
  {
    path: "assets/screenshots/motions-53.gif",
    width: 480,
    height: 272,
    badge: "large",
    gravity: "southeast",
    offsetX: 4,
    offsetY: 1,
  },
  {
    path: "site/assets/home/motions-53.gif",
    width: 480,
    height: 272,
    badge: "large",
    gravity: "southeast",
    offsetX: 4,
    offsetY: 1,
  },
  {
    path: "assets/screenshots/motions-3d.gif",
    width: 480,
    height: 272,
    badge: "large",
    gravity: "southeast",
    offsetX: 4,
    offsetY: 1,
  },
  {
    path: "site/assets/blog/page-3d.gif",
    width: 480,
    height: 272,
    badge: "large",
    gravity: "southeast",
    offsetX: 4,
    offsetY: 1,
  },
  ...["menu", "spin", "reveal", "room", "share", "reload", "dpad"].map(
    (name): MotionCreditAsset => ({
      path: `site/assets/blog/${name}.gif`,
      width: 154,
      height: 121,
      badge: "small",
      gravity: "northeast",
      offsetX: 3,
      offsetY: 3,
    }),
  ),
];

export function renderMotionCreditBadge(size: MotionCreditBadge): Buffer {
  const spec = BADGES[size];
  const canvas = createCanvas(spec.width, spec.height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#14171c";
  ctx.fillRect(0, 0, spec.width, spec.height);
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 ${spec.fontSize}px Inter`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(CREDIT, spec.width / 2, spec.height / 2 + 0.5);

  return canvas.toBuffer("image/png");
}

const magick = Bun.which("magick");

function runMagick(args: string[]): string {
  if (!magick) throw new Error("motion credit: ImageMagick `magick` is required");
  const result = Bun.spawnSync([magick, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  if (result.exitCode !== 0) {
    throw new Error(`motion credit: magick ${args.join(" ")} failed\n${result.stderr.toString()}`);
  }
  return stdout;
}

function creditCrop(asset: MotionCreditAsset): string {
  const badge = BADGES[asset.badge];
  const x = asset.width - badge.width - asset.offsetX;
  const y =
    asset.gravity === "northeast"
      ? asset.offsetY
      : asset.height - badge.height - asset.offsetY;
  return `${badge.width}x${badge.height}+${x}+${y}`;
}

function inspectCredit(path: string, asset: MotionCreditAsset): string | undefined {
  if (!existsSync(path)) return "asset is missing";

  const dimensions = runMagick(["identify", "-format", "%wx%h", `${path}[0]`]).trim();
  if (dimensions !== `${asset.width}x${asset.height}`) {
    return `expected ${asset.width}x${asset.height}, found ${dimensions}`;
  }

  const comment = runMagick(["identify", "-format", "%c", `${path}[0]`]);
  if (!comment.includes(CREDIT_MARKER)) return "generated credit marker is missing";

  const means = runMagick([
    path,
    "-coalesce",
    "-crop",
    creditCrop(asset),
    "+repage",
    "-colorspace",
    "gray",
    "-threshold",
    "70%",
    "-format",
    "%[fx:mean]\n",
    "info:",
  ])
    .trim()
    .split("\n")
    .map(Number);
  if (means.length === 0 || means.some((value) => !Number.isFinite(value))) {
    return "could not inspect credited frames";
  }
  if (means.some((value) => value < 0.05 || value > 0.35)) {
    return "credited region does not contain legible light text on a dark badge";
  }
  if (Math.max(...means) - Math.min(...means) > 0.005) {
    return "credit is not persistent across every frame";
  }
}

function stampCredit(
  asset: MotionCreditAsset,
  source: string,
  destination: string,
  badgePath: string,
): void {
  runMagick([
    source,
    "-coalesce",
    "null:",
    badgePath,
    "-gravity",
    asset.gravity,
    "-geometry",
    `+${asset.offsetX}+${asset.offsetY}`,
    "-compose",
    "over",
    "-layers",
    "composite",
    "-set",
    "comment",
    CREDIT_MARKER,
    "-layers",
    "Optimize",
    destination,
  ]);
}

export function ensureMotionCredits(options: { checkOnly?: boolean } = {}): {
  checked: number;
  stamped: string[];
} {
  const missing: string[] = [];
  const stamped: string[] = [];
  let temp = "";

  try {
    for (const asset of MOTION_CREDIT_ASSETS) {
      const absolute = ROOT + asset.path;
      const problem = inspectCredit(absolute, asset);
      if (!problem) continue;
      if (options.checkOnly) {
        missing.push(`${asset.path}: ${problem}`);
        continue;
      }

      if (!temp) {
        temp = mkdtempSync(join(tmpdir(), "pocketjs-motion-credit-"));
        for (const size of Object.keys(BADGES) as MotionCreditBadge[]) {
          writeFileSync(join(temp, `${size}.png`), renderMotionCreditBadge(size));
        }
      }

      const output = join(temp, asset.path.replaceAll("/", "_"));
      stampCredit(asset, absolute, output, join(temp, `${asset.badge}.png`));
      const stampedProblem = inspectCredit(output, asset);
      if (stampedProblem) {
        throw new Error(`motion credit: generated ${asset.path}: ${stampedProblem}`);
      }
      copyFileSync(output, absolute);
      stamped.push(asset.path);
    }
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }

  if (missing.length > 0) {
    throw new Error(`motion credit check failed:\n- ${missing.join("\n- ")}`);
  }

  return { checked: MOTION_CREDIT_ASSETS.length, stamped };
}
