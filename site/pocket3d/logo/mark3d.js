// The PocketJS mark as a solid: its 2D outline is extruded along z, turned,
// and projected to an SVG string. The logo study page draws every option with
// this, and `bun -e` prints a static SVG from it for a chosen option.
//
// Model space is the mark's own 32 x 32 box: x right, y down, z toward the
// viewer. The front face sits at z = 0 and the body runs back to z = -depth.

const BODY = { x: 0.7, y: 4.7, w: 30.6, h: 22.6, r: 7.3 };   // outer edge of the 2.6 stroke around 28 x 20 rx 6
const PANEL = { x: 3.3, y: 7.3, w: 25.4, h: 17.4, r: 4.7 };  // inner edge of that stroke
const LENS = { cx: 10, cy: 16, r: 3.1 };
const KEYS = [
  { x: 16, y: 12.6, w: 10, h: 2.2, r: 1.1, fill: "#3fd0e8", side: ["#2aa9c2", "#1b7f95"] },
  { x: 16, y: 17.2, w: 6.5, h: 2.2, r: 1.1, fill: "#ff5f9e", side: ["#d9417d", "#a82a5b"] },
];

export const DEFAULTS = {
  yaw: -28,        // degrees about the vertical axis; negative shows the left side
  pitch: 10,       // degrees about the horizontal axis; positive shows the top
  depth: 7,        // extrusion length in mark units
  persp: 70,       // camera distance in mark units; 0 draws without perspective
  oblique: null,   // [dx, dy] per unit of depth: a cabinet projection instead of a turn
  shift: [0, 0],   // offset of the mark from the optical axis, for a one-point vanishing extrusion
  emboss: 0,       // height the lens and keys rise from the face
  outline: 0,      // width of a plum keyline around the whole silhouette
  size: 32,        // side of the square view box the result is fitted into
  pad: 1,
};

const rad = (deg) => (deg * Math.PI) / 180;
const mix = (a, b, t) => {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (shift) => Math.round(((pa >> shift) & 255) + (((pb >> shift) & 255) - ((pa >> shift) & 255)) * t);
  return "#" + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
};

function roundRect({ x, y, w, h, r }, steps = 7) {
  const pts = [];
  const corners = [[x + w - r, y + r, -90], [x + w - r, y + h - r, 0], [x + r, y + h - r, 90], [x + r, y + r, 180]];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = rad(start + (90 * i) / steps);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}
function circle({ cx, cy, r }, steps = 28) {
  return Array.from({ length: steps }, (_, i) => [cx + r * Math.cos((i / steps) * 2 * Math.PI), cy + r * Math.sin((i / steps) * 2 * Math.PI)]);
}

export function mark3d(options = {}) {
  const o = { ...DEFAULTS, ...options };
  const cy = Math.cos(rad(o.yaw)), sy = Math.sin(rad(o.yaw));
  const cx = Math.cos(rad(o.pitch)), sx = Math.sin(rad(o.pitch));
  const turn = ([x, y, z]) => {
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    return [x1, y * cx - z1 * sx, y * sx + z1 * cx];
  };
  // model point -> view space (centred on the mark, turned, then moved off axis)
  const view = (x, y, z) => {
    if (o.oblique) return [x - 16 - z * o.oblique[0], y - 16 - z * o.oblique[1], z];
    const [vx, vy, vz] = turn([x - 16, y - 16, z + o.depth / 2]);
    return [vx + o.shift[0], vy + o.shift[1], vz];
  };
  const flat = o.oblique || !o.persp;
  const project = ([x, y, z]) => (flat ? [x, y] : [(x * o.persp) / (o.persp - z), (y * o.persp) / (o.persp - z)]);
  const light = (() => { const l = [-0.45, -0.7, 0.55]; const n = Math.hypot(...l); return l.map((v) => v / n); })();

  const out = [];      // { d, fill } in paint order
  const all = [];      // every projected point, for the fit
  const path = (pts) => "M" + pts.map((p) => { all.push(p); return p[0].toFixed(2) + " " + p[1].toFixed(2); }).join("L") + "Z";

  // A prism over a convex outline from z0 (back) to z1 (front): its visible side
  // quads shaded by their normal, then its front face.
  function prism(outline, z0, z1, side, face) {
    const cxm = outline.reduce((s, p) => s + p[0], 0) / outline.length;
    const cym = outline.reduce((s, p) => s + p[1], 0) / outline.length;
    if (z1 - z0 > 0.001) {
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i], b = outline[(i + 1) % outline.length];
        let nx = b[1] - a[1], ny = -(b[0] - a[0]);
        const len = Math.hypot(nx, ny);
        if (len < 1e-6) continue;
        nx /= len; ny /= len;
        if (nx * ((a[0] + b[0]) / 2 - cxm) + ny * ((a[1] + b[1]) / 2 - cym) < 0) { nx = -nx; ny = -ny; }
        const quad = [view(a[0], a[1], z1), view(b[0], b[1], z1), view(b[0], b[1], z0), view(a[0], a[1], z0)];
        let n, facing;
        if (o.oblique) {
          // the back face is displaced by (depth * ox, depth * oy): a side shows when its normal points that way
          n = [nx, ny, 0];
          facing = nx * o.oblique[0] + ny * o.oblique[1];
        } else {
          n = turn([nx, ny, 0]);
          const mid = quad[0].map((v, k) => (v + quad[2][k]) / 2);
          facing = o.persp ? n[0] * -mid[0] + n[1] * -mid[1] + n[2] * (o.persp - mid[2]) : n[2];
        }
        if (facing <= 0) continue;
        const lit = Math.max(0, Math.min(1, 0.5 + 0.6 * (n[0] * light[0] + n[1] * light[1] + n[2] * light[2])));
        out.push({ d: path(quad.map(project)), fill: mix(side[1], side[0], lit), seam: true });
      }
    }
    if (face) out.push({ d: path(outline.map((p) => project(view(p[0], p[1], z1)))), fill: face });
  }

  const body = roundRect(BODY);
  prism(body, -o.depth, 0, ["#f6b622", "#a8640a"], "url(#m3d-gold)");
  out.push({ d: path(roundRect(PANEL).map((p) => project(view(p[0], p[1], 0)))), fill: "#171226" });
  prism(circle(LENS), 0, o.emboss, ["#d9417d", "#a82a5b"], "#ff5f9e");
  for (const key of KEYS) prism(roundRect(key, 5), 0, o.emboss, key.side, key.fill);

  // fit the drawing into the square, centred
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of all) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const grow = o.outline / 2;
  const span = Math.max(x1 - x0, y1 - y0) + 2 * grow;
  const scale = span / (o.size - 2 * o.pad);
  const box = [(x0 + x1) / 2 - (o.size / 2) * scale, (y0 + y1) / 2 - (o.size / 2) * scale, o.size * scale, o.size * scale];

  const shapes = out.map((s) => `<path d="${s.d}" fill="${s.fill}"${s.seam ? ` stroke="${s.fill}" stroke-width=".12" stroke-linejoin="round"` : ""}/>`).join("");
  const keyline = o.outline
    ? `<g fill="#221338" stroke="#221338" stroke-width="${(o.outline * scale).toFixed(2)}" stroke-linejoin="round">${out.map((s) => `<path d="${s.d}"/>`).join("")}</g>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.map((v) => v.toFixed(2)).join(" ")}">` +
    `<defs><linearGradient id="m3d-gold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe98a"/><stop offset=".45" stop-color="#ffd23f"/><stop offset="1" stop-color="#ffbe1f"/></linearGradient></defs>` +
    keyline + shapes + `</svg>`;
}

// The options the study compares. `name` and `note` are shown beside each one.
export const OPTIONS = [
  { id: "block", name: "Block", note: "Front on, pushed back down and to the right. The face is the PocketJS mark unchanged.",
    opts: { oblique: [0.62, 0.62], depth: 5 } },
  { id: "left", name: "Turned left", note: "Turned 28 degrees with a little top showing, in perspective.",
    opts: { yaw: -28, pitch: 10, depth: 7, persp: 70 } },
  { id: "right", name: "Turned right", note: "The same turn to the other side, so the keys lead.",
    opts: { yaw: 28, pitch: 10, depth: 7, persp: 70 } },
  { id: "desk", name: "On the desk", note: "Tilted back as if lying on a table, seen from the front and above.",
    opts: { yaw: -18, pitch: 42, depth: 6, persp: 80 } },
  { id: "vanish", name: "Vanishing point", note: "Front on, with a long extrusion that narrows to a point down and to the right.",
    opts: { yaw: 0, pitch: 0, depth: 20, persp: 60, shift: [-40, -32] } },
  { id: "brick", name: "Brick", note: "A thick body with raised lens and keys, nearly isometric.",
    opts: { yaw: -36, pitch: 24, depth: 11, persp: 220, emboss: 1.3 } },
];
