// framework/compiler/bake-svg.ts — tiny offline SVG rasterizer for baked UI icons.
//
// This is deliberately scoped to the assets we want to ship in pak today:
// SVGs containing filled <circle> and axis-aligned <rect>
// elements, composited in document order. Edges are supersampled before
// being written as straight-alpha RGBA, so icons keep subpixel coverage on
// both the wasm rasterizer and the PSP texture path.
//
// `fill="hole"` on any shape ERASES instead of painting (alpha-subtract with
// the same antialiased coverage) — that is how mask textures are baked, e.g.
// an opaque card with a transparent circle punched out for a circular-reveal
// animation (scale the mask up and the hole grows).

import type { DecodedImage } from "./pak.ts";
import { TEX_MAX_DIM } from "../../contracts/spec/spec.ts";

export const SVG_SUPERSAMPLE = 4;

interface Circle {
  kind: "circle";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  hole: boolean;
  rgba: [number, number, number, number];
}

interface Rect {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  hole: boolean;
  rgba: [number, number, number, number];
}

interface PathShape {
  kind: "path";
  /** Flattened closed contours in PIXEL coords (curves subdivided). */
  contours: [number, number][][];
  evenOdd: boolean;
  hole: boolean;
  rgba: [number, number, number, number];
  /** Pixel-space AABB (clamped later). */
  bbox: [number, number, number, number];
}

type Shape = Circle | Rect | PathShape;

// ---- SVG path data (`d`) parsing + flattening ------------------------------------

const CURVE_STEPS = 16;

/** Tokenize path data into commands + numbers. */
function pathTokens(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtZz])|(-?\d*\.?\d+(?:e[+-]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    if (m[1]) out.push(m[1]);
    else out.push(parseFloat(m[2]));
  }
  return out;
}

/**
 * Flatten path data into closed polygonal contours (viewBox coords).
 * Supports M/L/H/V/C/S/Q/T/Z (absolute + relative) — the fill-icon subset;
 * elliptical arcs (A) are a loud error.
 */
function flattenPath(d: string): [number, number][][] {
  const toks = pathTokens(d);
  const contours: [number, number][][] = [];
  let cur: [number, number][] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let prevC: [number, number] | null = null; // last cubic control (for S)
  let prevQ: [number, number] | null = null; // last quadratic control (for T)
  let i = 0;
  let cmd = "";
  const num = () => {
    const v = toks[i++];
    if (typeof v !== "number") throw new Error(`svg bake: expected number in path data (got ${v})`);
    return v;
  };
  const close = () => {
    if (cur.length >= 3) contours.push(cur);
    cur = [];
  };
  const lineTo = (nx: number, ny: number) => {
    x = nx;
    y = ny;
    cur.push([x, y]);
  };
  const cubicTo = (c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number) => {
    const sx = x;
    const sy = y;
    for (let s = 1; s <= CURVE_STEPS; s++) {
      const t = s / CURVE_STEPS;
      const u = 1 - t;
      const px = u * u * u * sx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * ex;
      const py = u * u * u * sy + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ey;
      cur.push([px, py]);
    }
    x = ex;
    y = ey;
    prevC = [c2x, c2y];
  };
  while (i < toks.length) {
    const t = toks[i];
    if (typeof t === "string") {
      cmd = t;
      i++;
    }
    // (implicit command repetition: keep the previous cmd)
    switch (cmd) {
      case "M": case "m": {
        const rel = cmd === "m";
        const nx = num();
        const ny = num();
        close();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        startX = x;
        startY = y;
        cur.push([x, y]);
        cmd = rel ? "l" : "L"; // subsequent pairs are implicit lineTos
        prevC = prevQ = null;
        break;
      }
      case "L": case "l": {
        const rel = cmd === "l";
        const nx = num();
        const ny = num();
        lineTo(rel ? x + nx : nx, rel ? y + ny : ny);
        prevC = prevQ = null;
        break;
      }
      case "H": case "h": {
        const nx = num();
        lineTo(cmd === "h" ? x + nx : nx, y);
        prevC = prevQ = null;
        break;
      }
      case "V": case "v": {
        const ny = num();
        lineTo(x, cmd === "v" ? y + ny : ny);
        prevC = prevQ = null;
        break;
      }
      case "C": case "c": {
        const rel = cmd === "c";
        const c1x = rel ? x + num() : num();
        const c1y = rel ? y + num() : num();
        const c2x = rel ? x + num() : num();
        const c2y = rel ? y + num() : num();
        const ex = rel ? x + num() : num();
        const ey = rel ? y + num() : num();
        cubicTo(c1x, c1y, c2x, c2y, ex, ey);
        prevQ = null;
        break;
      }
      case "S": case "s": {
        const rel = cmd === "s";
        const c1x = prevC ? 2 * x - prevC[0] : x;
        const c1y = prevC ? 2 * y - prevC[1] : y;
        const c2x = rel ? x + num() : num();
        const c2y = rel ? y + num() : num();
        const ex = rel ? x + num() : num();
        const ey = rel ? y + num() : num();
        cubicTo(c1x, c1y, c2x, c2y, ex, ey);
        prevQ = null;
        break;
      }
      case "Q": case "q": {
        const rel = cmd === "q";
        const qx = rel ? x + num() : num();
        const qy = rel ? y + num() : num();
        const ex = rel ? x + num() : num();
        const ey = rel ? y + num() : num();
        // quadratic -> cubic
        cubicTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        prevQ = [qx, qy];
        prevC = null;
        break;
      }
      case "T": case "t": {
        const rel = cmd === "t";
        const qx: number = prevQ ? 2 * x - prevQ[0] : x;
        const qy: number = prevQ ? 2 * y - prevQ[1] : y;
        const ex = rel ? x + num() : num();
        const ey = rel ? y + num() : num();
        cubicTo(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        prevQ = [qx, qy];
        prevC = null;
        break;
      }
      case "Z": case "z":
        lineTo(startX, startY);
        close();
        prevC = prevQ = null;
        break;
      case "A": case "a":
        throw new Error("svg bake: elliptical arcs (A) are not supported — convert to beziers.");
      default:
        throw new Error(`svg bake: unsupported path command \`${cmd}\`.`);
    }
  }
  close();
  return contours;
}

/** `transform="rotate(a [cx cy])"` / translate / scale, composed left→right. */
function parseSvgTransform(value: string | undefined): (p: [number, number]) => [number, number] {
  if (!value) return (p) => p;
  const ops: Array<(p: [number, number]) => [number, number]> = [];
  const re = /(rotate|translate|scale)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value))) {
    const args = m[2].split(/[\s,]+/).filter((s) => s.length > 0).map(Number);
    if (m[1] === "rotate") {
      const rad = ((args[0] ?? 0) * Math.PI) / 180;
      const cx = args[1] ?? 0;
      const cy = args[2] ?? 0;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      ops.push(([px, py]) => {
        const dx = px - cx;
        const dy = py - cy;
        return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
      });
    } else if (m[1] === "translate") {
      const tx = args[0] ?? 0;
      const ty = args[1] ?? 0;
      ops.push(([px, py]) => [px + tx, py + ty]);
    } else {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      ops.push(([px, py]) => [px * sx, py * sy]);
    }
  }
  return (p) => ops.reduce((acc, op) => op(acc), p);
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1]] = m[2] ?? m[3] ?? "";
  return out;
}

function num(v: string | undefined, name: string): number {
  if (v === undefined) throw new Error(`svg bake: missing ${name}`);
  const n = Number(v.replace(/px$/, ""));
  if (!Number.isFinite(n)) throw new Error(`svg bake: invalid ${name}="${v}"`);
  return n;
}

function parseColor(value: string | undefined): [number, number, number, number] {
  let s = value ?? "#000000";
  if (s === "white") s = "#ffffff";
  else if (s === "black") s = "#000000";
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return [
      parseInt(s[1] + s[1], 16),
      parseInt(s[2] + s[2], 16),
      parseInt(s[3] + s[3], 16),
      255,
    ];
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) {
    return [
      parseInt(s.slice(1, 3), 16),
      parseInt(s.slice(3, 5), 16),
      parseInt(s.slice(5, 7), 16),
      s.length === 9 ? parseInt(s.slice(7, 9), 16) : 255,
    ];
  }
  throw new Error(`svg bake: unsupported fill "${s}"`);
}

function parseOpacity(v: string | undefined): number {
  if (v === undefined) return 1;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`svg bake: invalid opacity="${v}"`);
  return Math.max(0, Math.min(1, n));
}

function sourceOver(px: Uint8Array, i: number, src: [number, number, number, number], srcA01: number): void {
  if (srcA01 <= 0) return;
  const dstA01 = px[i + 3] / 255;
  const outA = srcA01 + dstA01 * (1 - srcA01);
  if (outA <= 0) return;
  px[i] = Math.round((src[0] * srcA01 + px[i] * dstA01 * (1 - srcA01)) / outA);
  px[i + 1] = Math.round((src[1] * srcA01 + px[i + 1] * dstA01 * (1 - srcA01)) / outA);
  px[i + 2] = Math.round((src[2] * srcA01 + px[i + 2] * dstA01 * (1 - srcA01)) / outA);
  px[i + 3] = Math.round(outA * 255);
}

/** `fill="hole"`: alpha-subtract by coverage (colors untouched). */
function erase(px: Uint8Array, i: number, cov01: number): void {
  if (cov01 <= 0) return;
  px[i + 3] = Math.round(px[i + 3] * (1 - cov01));
}

export function bakeSvg(svg: string, rasterDensity = 1): DecodedImage {
  if (!Number.isInteger(rasterDensity) || rasterDensity < 1 || rasterDensity > 255) {
    throw new RangeError(
      `svg bake: rasterDensity must be an integer from 1 through 255 (got ${rasterDensity})`,
    );
  }
  const svgTag = svg.match(/<svg\b[^>]*>/i)?.[0];
  if (!svgTag) throw new Error("svg bake: missing <svg>");
  const root = attrs(svgTag);
  const logicalWidth = Math.round(num(root.width, "width"));
  const logicalHeight = Math.round(num(root.height, "height"));
  if (logicalWidth <= 0 || logicalHeight <= 0) {
    throw new Error(`svg bake: bad dimensions ${logicalWidth}x${logicalHeight}`);
  }
  const requestedWidth = logicalWidth * rasterDensity;
  const requestedHeight = logicalHeight * rasterDensity;
  if (requestedWidth > TEX_MAX_DIM || requestedHeight > TEX_MAX_DIM) {
    throw new RangeError(
      `svg bake: requested raster ${requestedWidth}x${requestedHeight} exceeds texture limit ${TEX_MAX_DIM}`,
    );
  }
  // Textures use full UV bounds. Rasterize the whole viewBox into the next
  // power of two instead of adding transparent padding, which would shrink
  // the artwork when the texture is mapped onto its logical layout bounds.
  const width = 2 ** Math.ceil(Math.log2(requestedWidth));
  const height = 2 ** Math.ceil(Math.log2(requestedHeight));
  const viewBox = (root.viewBox ?? `0 0 ${logicalWidth} ${logicalHeight}`).trim().split(/\s+/).map(Number);
  if (viewBox.length !== 4 || viewBox.some((n) => !Number.isFinite(n))) {
    throw new Error(`svg bake: invalid viewBox="${root.viewBox}"`);
  }
  const [vbX, vbY, vbW, vbH] = viewBox;
  const sx = width / vbW;
  const sy = height / vbH;

  // <defs> content (clipPaths, masks) is never painted directly.
  const svgBody = svg.replace(/<defs[\s\S]*?<\/defs>/gi, "");
  // Shapes are scanned flat: a <g> wrapper is invisible to this baker, so a
  // transform on one would be silently dropped — shapes would pile up at
  // their untranslated coordinates (a sprite atlas with 7 blank cells shipped
  // this way once). Hard error; bake the offsets into the coordinates.
  if (/<g\b[^>]*\btransform=/i.test(svgBody)) {
    throw new Error(
      "svg bake: <g transform> is not applied by this baker - flatten the transform into the shapes' own coordinates",
    );
  }
  const shapes: Shape[] = [];
  const shapeRe = /<(circle|rect|path)\b[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = shapeRe.exec(svgBody))) {
    const a = attrs(m[0]);
    const tag = m[1].toLowerCase();
    if (tag === "path") {
      // Paths need an explicit paint: fill="none"/absent skips (clipPath
      // defs, stroke-only art) — the icon subset this bakes is fill-based.
      if (!a.fill || a.fill === "none") continue;
      const hole = a.fill === "hole";
      const rgba = hole ? ([0, 0, 0, 255] as [number, number, number, number]) : parseColor(a.fill);
      const op = parseOpacity(a.opacity) * parseOpacity(a["fill-opacity"]);
      rgba[3] = Math.round(rgba[3] * op);
      if (!a.d) continue;
      const xf = parseSvgTransform(a.transform);
      const contours = flattenPath(a.d).map((c) =>
        c.map((p) => {
          const [tx, ty] = xf(p);
          return [(tx - vbX) * sx, (ty - vbY) * sy] as [number, number];
        }),
      );
      if (contours.length === 0) continue;
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const c of contours) {
        for (const [px, py] of c) {
          bx0 = Math.min(bx0, px);
          by0 = Math.min(by0, py);
          bx1 = Math.max(bx1, px);
          by1 = Math.max(by1, py);
        }
      }
      shapes.push({
        kind: "path",
        contours,
        evenOdd: a["fill-rule"] === "evenodd" || a["clip-rule"] === "evenodd",
        hole,
        rgba,
        bbox: [bx0, by0, bx1, by1],
      });
      continue;
    }
    const hole = a.fill === "hole";
    const rgba = hole ? ([0, 0, 0, 255] as [number, number, number, number]) : parseColor(a.fill);
    const op = parseOpacity(a.opacity) * parseOpacity(a["fill-opacity"]);
    rgba[3] = Math.round(rgba[3] * op);
    if (tag === "circle") {
      // Preserve the requested raster's circle geometry when the two storage
      // axes expand by different amounts. Mapping full UVs back to the same
      // logical bounds cancels this storage-space ellipse.
      const radius = num(a.r, "r") * Math.min(requestedWidth / vbW, requestedHeight / vbH);
      shapes.push({
        kind: "circle",
        cx: (num(a.cx, "cx") - vbX) * sx,
        cy: (num(a.cy, "cy") - vbY) * sy,
        rx: radius * (width / requestedWidth),
        ry: radius * (height / requestedHeight),
        hole,
        rgba,
      });
    } else {
      shapes.push({
        kind: "rect",
        x: (num(a.x ?? "0", "x") - vbX) * sx,
        y: (num(a.y ?? "0", "y") - vbY) * sy,
        w: num(a.width, "width") * sx,
        h: num(a.height, "height") * sy,
        hole,
        rgba,
      });
    }
  }
  if (shapes.length === 0) throw new Error("svg bake: no supported shapes");

  const rgba = new Uint8Array(width * height * 4);
  const ss = SVG_SUPERSAMPLE;
  const samples = ss * ss;
  for (const s of shapes) {
    const [bx0, by0, bx1, by1] =
      s.kind === "circle"
        ? [s.cx - s.rx - 1, s.cy - s.ry - 1, s.cx + s.rx + 1, s.cy + s.ry + 1]
        : s.kind === "rect"
          ? [s.x - 1, s.y - 1, s.x + s.w + 1, s.y + s.h + 1]
          : [s.bbox[0] - 1, s.bbox[1] - 1, s.bbox[2] + 1, s.bbox[3] + 1];
    const x0 = Math.max(0, Math.floor(bx0));
    const y0 = Math.max(0, Math.floor(by0));
    const x1 = Math.min(width, Math.ceil(bx1));
    const y1 = Math.min(height, Math.ceil(by1));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        let covered = 0;
        if (s.kind === "circle") {
          const rr = s.rx * s.rx;
          for (let yy = 0; yy < ss; yy++) {
            const py = y + (yy + 0.5) / ss;
            for (let xx = 0; xx < ss; xx++) {
              const px = x + (xx + 0.5) / ss;
              const dx = px - s.cx;
              const dy = py - s.cy;
              // Keep the original arithmetic for equal scales so existing
              // power-of-two bakes retain their exact coverage bytes.
              if (s.rx === s.ry
                ? dx * dx + dy * dy <= rr
                : (dx / s.rx) ** 2 + (dy / s.ry) ** 2 <= 1) covered++;
            }
          }
        } else if (s.kind === "rect") {
          // Axis-aligned rect: exact analytic pixel coverage.
          const ox = Math.max(0, Math.min(x + 1, s.x + s.w) - Math.max(x, s.x));
          const oy = Math.max(0, Math.min(y + 1, s.y + s.h) - Math.max(y, s.y));
          covered = ox * oy * samples;
        } else {
          for (let yy = 0; yy < ss; yy++) {
            const py = y + (yy + 0.5) / ss;
            for (let xx = 0; xx < ss; xx++) {
              const px = x + (xx + 0.5) / ss;
              if (pointInContours(s.contours, px, py, s.evenOdd)) covered++;
            }
          }
        }
        if (covered > 0) {
          const cov01 = covered / samples;
          const i = (y * width + x) * 4;
          if (s.hole) {
            erase(rgba, i, cov01);
          } else {
            sourceOver(rgba, i, s.rgba, (s.rgba[3] / 255) * cov01);
          }
        }
      }
    }
  }

  return { width, height, rgba };
}

/** Winding test over flattened contours (nonzero or even-odd fill rule). */
function pointInContours(contours: [number, number][][], px: number, py: number, evenOdd: boolean): boolean {
  let winding = 0;
  let crossings = 0;
  for (const c of contours) {
    for (let i = 0; i < c.length; i++) {
      const [ax, ay] = c[i];
      const [bx, by] = c[(i + 1) % c.length];
      if (ay <= py ? by > py : by <= py) {
        // Edge crosses the horizontal ray at py; x of the intersection:
        const t = (py - ay) / (by - ay);
        const ix = ax + (bx - ax) * t;
        if (ix > px) {
          crossings++;
          winding += by > ay ? 1 : -1;
        }
      }
    }
  }
  return evenOdd ? (crossings & 1) === 1 : winding !== 0;
}
