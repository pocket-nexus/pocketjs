// Moon Racing's track and models, ported from GameBlocks' moon-racing demo
// (https://gb-moon-racing.vercel.app/, MIT, xt4d/GameBlocks): the checkpoint
// seeds and RoadTerrainSampler of src/game.js and RaceTrackEnvironment, the
// rover of CarVisualFactory + decorateMoonRoverVisual, the checkpoint gates,
// the barriers, the rock clusters and the star field.
//
// Coordinates: the demo's basis is right +Z, forward +X; here right is +X and
// forward is -Z, so a demo point (right, forward) sits at x = right,
// z = -forward (a rotation about Y; the scene is unchanged).
//
// Deviations: the 220-segment terrain mesh is a 40-sample heightfield drawn
// and collided natively; the demo lightens the regolith where the road
// flattens it, which a height-banded heightfield cannot draw, so the road is
// a flat strip laid on the same heightfield; barrier posts stand every
// 6.75 m instead of 2.25 m with six sides, and each side's rail is one box
// per track segment (the barrier ground is flat: the sampler holds it at 4 %
// of the terrain); rocks scale evenly by the mean of the demo's three
// factors; the front wheels steer but no wheel spins (an untextured wheel
// shows no spin); fewer segments throughout; stars are small tetrahedra
// instead of Points.

import * as THREE from "@pocketjs/framework/playset/three";

export const WORLD_HALF = 112;
export const WORLD_DRIVE_BOUND = WORLD_HALF - 4;
export const TERRAIN_SIZE = WORLD_HALF * 2;
export const TERRAIN_SAMPLES = 40;
export const CHECKPOINT_RADIUS = 8;
export const ROAD_HALF_WIDTH = 8;
export const BARRIER_OFFSET = 8;
export const BARRIER_HEIGHT = 1.45;

export const PALETTE = {
  space: 0x05060a,
  regolithLow: 0x3c3b37,
  regolith: 0x484642,
  regolithHigh: 0x56544e,
  road: 0x716d65,
  post: 0x646866,
  rail: 0xb2b0a8,
  gatePost: 0x252a30,
  gateBar: 0xa7a69d,
  flagA: 0xd7c06f,
  flagB: 0x94c8ff,
  rock: 0x4b4c4a,
  star: 0xf4f8ff,
};

/** The demo's buildLunarCheckpointSeeds, (right, forward) in race order. */
const SEEDS: readonly (readonly [number, number])[] = [
  [61, -4], [78, -32], [48, -66], [8, -78], [-18, -48], [-59, -68], [-82, -24],
  [-58, 12], [-78, 50], [-33, 79], [3, 54], [36, 82], [76, 44],
];

/** Checkpoints in playset coordinates. */
export const CHECKPOINTS: readonly (readonly [number, number])[] = SEEDS.map(([r, f]) => [r, -f] as const);

// --- RoadTerrainSampler (seed 2026 and the demo's moon settings) --------------

const SEED = 2026;
const ROAD_FLATNESS_AT_HALF_WIDTH = 0.96;
const LARGE_WAVE_SCALE = 0.022;
const LARGE_WAVE_AMP = 0.72;
const MID_NOISE_SCALE = 0.06;
const MID_NOISE_AMP = 0.34;

const fract = (v: number) => v - Math.floor(v);
const hash2D = (r: number, f: number, off: number) => fract(Math.sin(r * 127.1 + f * 311.7 + (SEED + off) * 101.3) * 43758.5453123);
function noise2D(r: number, f: number, off: number): number {
  const ri = Math.floor(r);
  const fi = Math.floor(f);
  const rf = r - ri;
  const ff = f - fi;
  const rb = rf * rf * (3 - 2 * rf);
  const fb = ff * ff * (3 - 2 * ff);
  const a = hash2D(ri, fi, off);
  const b = hash2D(ri + 1, fi, off);
  const c = hash2D(ri, fi + 1, off);
  const d = hash2D(ri + 1, fi + 1, off);
  const low = a + (b - a) * rb;
  const high = c + (d - c) * rb;
  return (low + (high - low) * fb) * 2 - 1;
}

/** Planar distance from (x, z) to the track's centre line. */
export function distanceToRoad(x: number, z: number): number {
  let best = Infinity;
  const n = CHECKPOINTS.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = CHECKPOINTS[i];
    const [bx, bz] = CHECKPOINTS[(i + 1) % n];
    const dx = bx - ax;
    const dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    const ex = x - (ax + dx * t);
    const ez = z - (az + dz * t);
    best = Math.min(best, ex * ex + ez * ez);
  }
  return Math.sqrt(best);
}

/** The demo's heightAt(right, forward), taking playset (x, z). */
export function moonHeight(x: number, z: number): number {
  const right = x;
  const forward = -z;
  const ratio = distanceToRoad(x, z) / ROAD_HALF_WIDTH;
  const flatness = ROAD_FLATNESS_AT_HALF_WIDTH ** (ratio * ratio);
  const wave = Math.sin(right * LARGE_WAVE_SCALE) * LARGE_WAVE_AMP + Math.cos(forward * LARGE_WAVE_SCALE) * LARGE_WAVE_AMP;
  const mid = noise2D(right * MID_NOISE_SCALE, forward * MID_NOISE_SCALE, 31) * MID_NOISE_AMP;
  return (wave + mid) * (1 - flatness);
}

/** The heightfield the game draws and drives on, row-major, row 0 at -Z. */
export function terrainHeights(): Float32Array {
  const n = TERRAIN_SAMPLES;
  const cell = TERRAIN_SIZE / (n - 1);
  const h = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) h[iz * n + ix] = moonHeight(ix * cell - WORLD_HALF, iz * cell - WORLD_HALF);
  return h;
}

/** Bilinear height of the drawn heightfield (the native sampler's rule). */
export function sampleHeights(h: Float32Array, x: number, z: number): number {
  const n = TERRAIN_SAMPLES;
  const cell = TERRAIN_SIZE / (n - 1);
  const fx = Math.max(0, Math.min(n - 1, (x + WORLD_HALF) / cell));
  const fz = Math.max(0, Math.min(n - 1, (z + WORLD_HALF) / cell));
  const ix = Math.min(n - 2, Math.floor(fx));
  const iz = Math.min(n - 2, Math.floor(fz));
  const tx = fx - ix;
  const tz = fz - iz;
  const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

/** Colour stops by height: low dust, regolith, raised regolith. */
export const TERRAIN_BANDS: readonly (readonly [number, number])[] = [
  [-1.6, PALETTE.regolithLow],
  [0, PALETTE.regolith],
  [1.4, PALETTE.regolithHigh],
];

// --- track geometry ---------------------------------------------------------------

/** The demo's offsetPath: each point pushed along its side normal, outward
 *  (sign 1) or inward (sign -1) from the track's centroid. */
export function offsetPath(offset: number, sideSign: number): [number, number][] {
  const n = CHECKPOINTS.length;
  let cx = 0, cz = 0;
  for (const [x, z] of CHECKPOINTS) {
    cx += x / n;
    cz += z / n;
  }
  return CHECKPOINTS.map(([x, z], i) => {
    const [px, pz] = CHECKPOINTS[(i - 1 + n) % n];
    const [nx, nz] = CHECKPOINTS[(i + 1) % n];
    let tx = nx - px, tz = nz - pz;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // a perpendicular on the ground plane
    const sx = -tz, sz = tx;
    const rx = x - cx, rz = z - cz;
    const outward = sx * rx + sz * rz >= 0 ? 1 : -1;
    return [x + sx * offset * sideSign * outward, z + sz * offset * sideSign * outward];
  });
}

/** Corner angle at each checkpoint (WaypointProgressTracker.cornerProfile). */
export function cornerMagnitudes(): number[] {
  const n = CHECKPOINTS.length;
  return CHECKPOINTS.map(([x, z], i) => {
    const [px, pz] = CHECKPOINTS[(i - 1 + n) % n];
    const [nx, nz] = CHECKPOINTS[(i + 1) % n];
    const ax = x - px, az = z - pz, bx = nx - x, bz = nz - z;
    const dot = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz));
    return Math.acos(Math.max(-1, Math.min(1, dot)));
  });
}

function rawMesh(positions: number[], material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  return new THREE.Mesh(geometry, material);
}

/** One road segment from checkpoint i to i + 1, with a disc at its start to
 *  round the corner, relative to `origin`, laid on the heightfield. */
export function roadSegment(i: number, heights: Float32Array, origin: readonly [number, number]): THREE.Group {
  const n = CHECKPOINTS.length;
  const [ax, az] = CHECKPOINTS[i];
  const [bx, bz] = CHECKPOINTS[(i + 1) % n];
  const len = Math.hypot(bx - ax, bz - az);
  const dx = (bx - ax) / len, dz = (bz - az) / len;
  const sx = -dz * ROAD_HALF_WIDTH, sz = dx * ROAD_HALF_WIDTH;
  const lift = 0.07;
  const y = (x: number, z: number) => sampleHeights(heights, x, z) + lift;
  const p: number[] = [];
  const push = (x: number, z: number) => p.push(x - origin[0], y(x, z), z - origin[1]);
  const steps = Math.max(1, Math.round(len / 6));
  for (let k = 0; k < steps; k++) {
    const t0 = k / steps, t1 = (k + 1) / steps;
    const x0 = ax + (bx - ax) * t0, z0 = az + (bz - az) * t0;
    const x1 = ax + (bx - ax) * t1, z1 = az + (bz - az) * t1;
    // counter-clockwise from above (+Y): left edge, right edge
    push(x0 - sx, z0 - sz); push(x0 + sx, z0 + sz); push(x1 + sx, z1 + sz);
    push(x0 - sx, z0 - sz); push(x1 + sx, z1 + sz); push(x1 - sx, z1 - sz);
  }
  const sides = 10;
  for (let k = 0; k < sides; k++) {
    const a0 = (k / sides) * Math.PI * 2, a1 = ((k + 1) / sides) * Math.PI * 2;
    push(ax, az);
    push(ax + Math.cos(a0) * ROAD_HALF_WIDTH, az - Math.sin(a0) * ROAD_HALF_WIDTH);
    push(ax + Math.cos(a1) * ROAD_HALF_WIDTH, az - Math.sin(a1) * ROAD_HALF_WIDTH);
  }
  const group = new THREE.Group();
  group.add(rawMesh(p, new THREE.MeshStandardMaterial({ color: PALETTE.road })));
  return group;
}

// --- rover ------------------------------------------------------------------------

const ROVER_WHEEL_RADIUS = 0.35;
/** wheelLayout.up - suspensionRestLength */
const WHEEL_CENTER_UP = 0.4 - 0.34;
/** the model origin sits this far above the ground at rest */
export const ROVER_RIDE_HEIGHT = WHEEL_CENTER_UP + ROVER_WHEEL_RADIUS;

/** createCarVisual + decorateMoonRoverVisual. Forward is -Z; the front
 *  wheels hang from the joints "fl" and "fr" so the kernel steers them. */
export function rover(o: { paint: number; accent: number | null }): THREE.Group {
  const isPlayer = o.accent !== null;
  const accentColor = o.accent ?? 0xd7c06f;
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.58, 3.0), new THREE.MeshStandardMaterial({ color: o.paint, metalness: 0.1 }));
  body.position.y = 0.42;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.45, 1.3), new THREE.MeshStandardMaterial({ color: isPlayer ? 0xf5f6ee : 0xdadbd5 }));
  cabin.position.set(0, 0.83, -0.1);
  group.add(body, cabin);

  const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x15171a });
  const wheelGeometry = new THREE.CylinderGeometry(ROVER_WHEEL_RADIUS, ROVER_WHEEL_RADIUS, 0.32, 8);
  wheelGeometry.rotateZ(Math.PI * 0.5);
  const wheelOffsets: [string | null, number, number][] = [
    ["fl", -0.98, -1.12],
    ["fr", 0.98, -1.12],
    [null, -0.98, 1.12],
    [null, 0.98, 1.12],
  ];
  for (const [name, x, z] of wheelOffsets) {
    const pivot = name ? new THREE.Joint(name) : new THREE.Group();
    pivot.position.set(x, WHEEL_CENTER_UP, z);
    pivot.add(new THREE.Mesh(wheelGeometry, wheelMaterial));
    group.add(pivot);
  }

  const frameMaterial = new THREE.MeshStandardMaterial({ color: 0xd0d2cc });
  const solarMaterial = new THREE.MeshStandardMaterial({ color: 0x10233a, emissive: 0x030914 });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: accentColor, emissive: isPlayer ? 0x061520 : 0x000000 });
  const glassMaterial = new THREE.MeshStandardMaterial({ color: isPlayer ? 0xb8e5ff : 0xa9c9dc });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 2.2), frameMaterial);
  deck.position.set(0, 1.12, 0.22);
  const frontSensor = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.18, 0.12), glassMaterial);
  frontSensor.position.set(0, 0.82, -1.58);
  group.add(deck, frontSensor);
  for (const side of [-1, 1]) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 1.55), solarMaterial);
    panel.position.set(side * 1.18, 0.78, -0.12);
    panel.rotation.z = side * 0.12;
    const middleWheel = new THREE.Mesh(new THREE.CylinderGeometry(ROVER_WHEEL_RADIUS, ROVER_WHEEL_RADIUS, 0.22, 8), wheelMaterial);
    middleWheel.rotation.z = Math.PI * 0.5;
    middleWheel.position.set(side * 0.98, WHEEL_CENTER_UP, 0);
    group.add(panel, middleWheel);
  }
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.82, 4, 1, true), frameMaterial);
  mast.position.set(-0.42, 1.62, 0.55);
  const antenna = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 4), accentMaterial);
  antenna.scale.set(1.35, 0.22, 1.35);
  antenna.position.set(-0.42, 2.06, 0.55);
  group.add(mast, antenna);
  if (isPlayer) {
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.52, 8, 4, 0, Math.PI * 2, 0, Math.PI * 0.55), glassMaterial);
    canopy.position.set(0, 1.28, -0.48);
    canopy.scale.set(1.28, 0.72, 0.92);
    const lightBar = new THREE.Mesh(new THREE.BoxGeometry(1.26, 0.1, 0.08), new THREE.MeshStandardMaterial({ color: 0x54d7ff, emissive: 0x0a5c7a }));
    lightBar.position.set(0, 0.92, 1.65);
    group.add(canopy, lightBar);
  }
  return group;
}

// --- scenery ----------------------------------------------------------------------

/** A checkpoint gate: two posts, a crossbar and two flags, facing along the
 *  track (the gate's local +Z is the tangent). */
export function checkpointGate(index: number): THREE.Group {
  const width = 16, height = 5.2, flagWidth = 3.0, flagHeight = 1.24;
  const gate = new THREE.Group();
  const post = new THREE.CylinderGeometry(0.08, 0.08, height, 4, 1, true);
  const postMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.gatePost });
  for (const side of [-1, 1]) {
    const mesh = new THREE.Mesh(post, postMaterial);
    mesh.position.set(side * width * 0.5, height * 0.5, 0);
    gate.add(mesh);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(width + 0.08 * 2.4, 0.09, 0.09), new THREE.MeshStandardMaterial({ color: PALETTE.gateBar }));
  bar.position.set(0, height, 0);
  gate.add(bar);
  const flagA = new THREE.MeshStandardMaterial({ color: PALETTE.flagA });
  const flagB = new THREE.MeshStandardMaterial({ color: PALETTE.flagB });
  const materials = index % 2 === 0 ? [flagA, flagB] : [flagB, flagA];
  const offsets = [-width * 0.5 + flagWidth * 0.5, width * 0.5 - flagWidth * 0.5];
  for (let f = 0; f < 2; f++) {
    const flag = new THREE.Mesh(new THREE.BoxGeometry(flagWidth, flagHeight, 0.035), materials[f]);
    flag.position.set(offsets[f], height - flagHeight * 0.65, 0);
    gate.add(flag);
  }
  return gate;
}

/** The beacon over the player's next gate (the demo marks it on its minimap). */
export function nextGateBeacon(): THREE.Group {
  const group = new THREE.Group();
  const arrow = new THREE.Mesh(
    new THREE.ConeGeometry(0.9, 1.8, 4),
    new THREE.MeshBasicMaterial({ color: PALETTE.flagB, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }),
  );
  arrow.rotation.x = Math.PI;
  group.add(arrow);
  return group;
}

export function barrierPost(): THREE.Group {
  const radius = BARRIER_HEIGHT * 0.24;
  const group = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, BARRIER_HEIGHT, 6), new THREE.MeshStandardMaterial({ color: PALETTE.post }));
  post.position.y = BARRIER_HEIGHT * 0.5;
  group.add(post);
  return group;
}

/** A rail of `length` along local Z at the demo's rail height. */
export function barrierRail(length: number): THREE.Group {
  const span = BARRIER_HEIGHT * 0.12;
  const group = new THREE.Group();
  const rail = new THREE.Mesh(new THREE.BoxGeometry(span, span, length), new THREE.MeshStandardMaterial({ color: PALETTE.rail }));
  rail.position.y = BARRIER_HEIGHT * 0.62;
  group.add(rail);
  return group;
}

export function rock(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.DodecahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: PALETTE.rock, flatShading: true })));
  return group;
}

/** The rock clusters of addLunarRocks, in playset (x, z). */
export function rockPlacements(): { x: number; z: number; rx: number; ry: number; rz: number; sx: number; sy: number; sz: number }[] {
  const clusters = [
    { right: -96, forward: -74, count: 7, spread: 18 },
    { right: 93, forward: -84, count: 6, spread: 16 },
    { right: -97, forward: 62, count: 8, spread: 19 },
    { right: 88, forward: 84, count: 6, spread: 15 },
    { right: 6, forward: -102, count: 5, spread: 14 },
  ];
  const out = [];
  for (const c of clusters) {
    for (let i = 0; i < c.count; i++) {
      const angle = i * 2.39996 + c.right * 0.017;
      const distance = c.spread * (0.26 + ((i * 37) % 61) / 95);
      const right = c.right + Math.cos(angle) * distance;
      const forward = c.forward + Math.sin(angle) * distance;
      const scale = 0.45 + ((i * 23) % 41) / 44;
      out.push({ x: right, z: -forward, rx: angle * 0.31, ry: angle * 0.17, rz: angle * 0.23, sx: scale * 1.35, sy: scale * 0.75, sz: scale });
    }
  }
  return out;
}

/** addLunarSkyObjects' 150 stars as small unlit tetrahedra, split into
 *  sectors (one model each) so the renderer can cull them. */
export function starSectors(sectors: number): { model: THREE.Group; at: [number, number, number] }[] {
  const out: { model: THREE.Group; at: [number, number, number] }[] = [];
  const buckets: number[][] = Array.from({ length: sectors }, () => []);
  const centers: [number, number, number][] = Array.from({ length: sectors }, () => [0, 0, 0]);
  const counts = new Array(sectors).fill(0);
  const stars: [number, number, number][] = [];
  for (let i = 0; i < 150; i++) {
    const angle = i * 2.399963;
    const radius = 118 + ((i * 29) % 92);
    const right = Math.cos(angle) * radius;
    const forward = Math.sin(angle) * radius;
    const up = 24 + ((i * 37) % 116);
    stars.push([right, up, -forward]);
  }
  for (const s of stars) {
    const a = Math.atan2(s[2], s[0]) + Math.PI;
    const k = Math.min(sectors - 1, Math.floor((a / (Math.PI * 2)) * sectors));
    counts[k]++;
    centers[k][0] += s[0];
    centers[k][1] += s[1];
    centers[k][2] += s[2];
  }
  for (let k = 0; k < sectors; k++) {
    if (counts[k]) for (let c = 0; c < 3; c++) centers[k][c] /= counts[k];
  }
  const size = 0.9;
  for (const s of stars) {
    const a = Math.atan2(s[2], s[0]) + Math.PI;
    const k = Math.min(sectors - 1, Math.floor((a / (Math.PI * 2)) * sectors));
    const [ox, oy, oz] = centers[k];
    const x = s[0] - ox, y = s[1] - oy, z = s[2] - oz;
    const v = [
      [x, y + size, z],
      [x - size * 0.94, y - size * 0.33, z - size * 0.54],
      [x + size * 0.94, y - size * 0.33, z - size * 0.54],
      [x, y - size * 0.33, z + size * 1.09],
    ];
    for (const [a, b, c] of [[0, 2, 1], [0, 3, 2], [0, 1, 3], [1, 2, 3]]) buckets[k].push(...v[a], ...v[b], ...v[c]);
  }
  for (let k = 0; k < sectors; k++) {
    if (!buckets[k].length) continue;
    const group = new THREE.Group();
    group.add(rawMesh(buckets[k], new THREE.MeshBasicMaterial({ color: PALETTE.star })));
    out.push({ model: group, at: centers[k] });
  }
  return out;
}
