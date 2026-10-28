// Jet Dogfight's world and models, ported from GameBlocks' jet-dogfight demo
// (https://gb-jet-dogfight.vercel.app/, MIT, xt4d/GameBlocks): src/terrain.js,
// the terrain colouring and clouds of src/main.js, AirplaneVisualFactory and
// ProjectileVisualFactory.
//
// Scale: the demo flies in metres at 88-260 m/s over a 14.5 km map; here one
// unit is 10 m (SCALE = 0.1), which keeps speeds, hit radii and the camera
// in the ranges the playset's grid and depth buffer are tuned for. The
// demo's basis is right +X, up +Z, forward +Y; a demo point (right, up,
// forward) sits at x = right, y = up, z = -forward.
//
// Deviations: the 180-segment, 14.5 km terrain plane is a 64-sample, 20 km
// heightfield drawn and flown over natively, coloured by the demo's height
// bands; clouds are opaque and keep their three largest puffs (the generator
// still draws every puff, so each cloud stands where the demo puts it); the
// shader jet flames are additive cones; a gun round is a tracer streak (the
// demo draws a ball and a separate tracer line); a missile adds a smoke
// stream to its trail cone.

import * as THREE from "@pocketjs/framework/playset/three";
import { mulberry } from "../kit/random.ts";

export const SCALE = 0.1;

export const COLORS = {
  sky: 0x8bc6ee,
  valley: 0x31592f,
  grass: 0x6d823f,
  earth: 0x8a7651,
  rock: 0x69717c,
  snow: 0xf2f7fb,
};

function mountainMass(r: number, f: number, cr: number, cf: number, rr: number, rf: number, h: number): number {
  const nr = (r - cr) / rr;
  const nf = (f - cf) / rf;
  return Math.exp(-(nr * nr + nf * nf)) * h;
}

/** terrain.js terrainHeightAtBasis, in metres. */
export function terrainHeightAtBasis(right: number, forward: number): number {
  const broadRidges = Math.sin(right * 0.00074 + forward * 0.00038) * 320 + Math.cos(forward * 0.00068 - right * 0.00031) * 270;
  const brokenHills =
    Math.sin((right + forward) * 0.00162) * 155 + Math.cos((right - forward) * 0.00132) * 130 + Math.sin(right * 0.0042) * Math.cos(forward * 0.0034) * 82;
  const peaks =
    mountainMass(right, forward, -4200, 2600, 1500, 1350, 630) +
    mountainMass(right, forward, 3600, 3100, 1450, 1300, 590) +
    mountainMass(right, forward, 0, 3600, 1300, 1500, 750) +
    mountainMass(right, forward, -900, 4700, 2100, 1250, 510) +
    mountainMass(right, forward, 2900, -3200, 1300, 1550, 490) +
    mountainMass(right, forward, -4200, 2600, 620, 540, 260) +
    mountainMass(right, forward, 3600, 3100, 560, 520, 230) +
    mountainMass(right, forward, 0, 3600, 520, 560, 310);
  return (-740 + broadRidges + brokenHills + peaks) * 0.5;
}

export const TERRAIN_SIZE = 2000;
export const TERRAIN_SAMPLES = 64;

/** The terrain in playset units at playset (x, z). */
export const terrainHeight = (x: number, z: number) => terrainHeightAtBasis(x / SCALE, -z / SCALE) * SCALE;

export function terrainHeights(): Float32Array {
  const n = TERRAIN_SAMPLES;
  const cell = TERRAIN_SIZE / (n - 1);
  const half = TERRAIN_SIZE / 2;
  const h = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) for (let ix = 0; ix < n; ix++) h[iz * n + ix] = terrainHeight(ix * cell - half, iz * cell - half);
  return h;
}

/** Bilinear height of the drawn heightfield (the native sampler's rule). */
export function sampleHeights(h: Float32Array, x: number, z: number): number {
  const n = TERRAIN_SAMPLES;
  const cell = TERRAIN_SIZE / (n - 1);
  const half = TERRAIN_SIZE / 2;
  let fx = (x + half) / cell;
  let fz = (z + half) / cell;
  fx = fx < 0 ? 0 : fx > n - 1 ? n - 1 : fx;
  fz = fz < 0 ? 0 : fz > n - 1 ? n - 1 : fz;
  const ix = fx >= n - 1 ? n - 2 : Math.floor(fx);
  const iz = fz >= n - 1 ? n - 2 : Math.floor(fz);
  const tx = fx - ix;
  const tz = fz - iz;
  const a = h[iz * n + ix], b = h[iz * n + ix + 1], c = h[(iz + 1) * n + ix], d = h[(iz + 1) * n + ix + 1];
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

/** _makeTerrain's colour ramp: valley, grass, earth, rock, snow (metres -900,
 *  -560, -120, 220, 580), in units. */
export const TERRAIN_BANDS: readonly (readonly [number, number])[] = [
  [-90, COLORS.valley],
  [-56, COLORS.grass],
  [-12, COLORS.earth],
  [22, COLORS.rock],
  [58, COLORS.snow],
];

/** _makeClouds (visual seed 20260616): 72 clouds of puffs, each puff a unit
 *  sphere's placement (centre and radii, in units). */
export function cloudPuffs(): { x: number; y: number; z: number; rx: number; ry: number; rz: number }[] {
  const rng = mulberry(20260616);
  const out: { x: number; y: number; z: number; rx: number; ry: number; rz: number }[] = [];
  for (let i = 0; i < 72; i++) {
    const parts = 4 + rng.int(0, 4);
    const puffs: { r: number; sx: number; sy: number; sz: number; px: number; py: number; pz: number }[] = [];
    for (let p = 0; p < parts; p++) {
      const r = rng.uniform(35, 95);
      const sx = rng.uniform(1.4, 3.4), sy = rng.uniform(0.25, 0.55), sz = rng.uniform(0.75, 1.6);
      const px = rng.uniform(-150, 150), py = rng.uniform(-12, 18), pz = rng.uniform(-80, 80);
      puffs.push({ r, sx, sy, sz, px, py, pz });
    }
    const right = rng.uniform(-5200, 5200), up = rng.uniform(820, 1650), forward = rng.uniform(-5200, 5200);
    // the three largest puffs carry the cloud's shape
    puffs.sort((a, b) => b.r * b.sx - a.r * a.sx);
    for (const p of puffs.slice(0, 3)) {
      out.push({ x: (right + p.px) * SCALE, y: (up + p.py) * SCALE, z: (-forward + p.pz) * SCALE, rx: p.r * p.sx * SCALE, ry: p.r * p.sy * SCALE, rz: p.r * p.sz * SCALE });
    }
  }
  return out;
}

export function cloudPuff(): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshLambertMaterial({ color: 0xf8fcff, emissive: 0x9ac8e4, emissiveIntensity: 0.28 })));
  return g;
}

// --- aircraft ---------------------------------------------------------------------

export interface AirplaneLook {
  scale: number;
  bodyColor: number;
  accentColor: number;
  /** the enemies' target ring */
  ring: number | null;
}

/** createAirplaneVisual: fuselage, nose, canopy, wings, tail, fin, engines and
 *  flames, the airframe centred on its bounds. Forward is -Z. */
export function airplane(o: AirplaneLook): THREE.Group {
  const group = new THREE.Group();
  const airframe = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: o.bodyColor });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: o.accentColor, emissive: 0x5a2200, emissiveIntensity: 0.26 });
  const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0x87cefa, emissive: 0x102c4b, emissiveIntensity: 0.4 });
  const fuselage = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 3.6, 8), bodyMaterial);
  fuselage.rotation.x = -Math.PI / 2;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.96, 8), accentMaterial);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -2.25;
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 5), canopyMaterial);
  canopy.scale.set(1.05, 0.7, 1.8);
  canopy.position.set(0, 0.25, -0.35);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(3.1, 0.1, 0.76), bodyMaterial);
  wing.position.set(0, -0.02, 0.16);
  const wingTip = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.04, 0.2), accentMaterial);
  wingTip.position.set(0, 0.06, -0.04);
  const tailWing = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.08, 0.42), bodyMaterial);
  tailWing.position.set(0, 0.28, 1.22);
  const tailFin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.86, 0.56), accentMaterial);
  tailFin.position.set(0, 0.56, 1.18);
  airframe.add(fuselage, nose, canopy, wing, wingTip, tailWing, tailFin);
  const engineGeometry = new THREE.CylinderGeometry(0.14, 0.19, 1.15, 6);
  const flameMaterial = new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending });
  for (const side of [-1, 1]) {
    const engine = new THREE.Mesh(engineGeometry, bodyMaterial);
    engine.rotation.x = Math.PI / 2;
    engine.position.set(side * 0.34, -0.1, 1.25);
    // JetFlameLocalVisual: a cone from the nozzle, tip aft
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.8, 5, 1, true), flameMaterial);
    flame.rotation.x = Math.PI / 2;
    flame.position.set(side * 0.34, -0.1, 1.78 + 0.4);
    airframe.add(engine, flame);
  }
  // the airframe's bounds are x ±1.8, y -0.36..0.99, z -2.73..1.83
  airframe.position.set(0, -0.315, 0.45);
  group.add(airframe);
  if (o.ring !== null) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.15, 0.035, 3, 16), new THREE.MeshBasicMaterial({ color: o.ring, transparent: true, opacity: 0.36 }));
    group.add(ring);
  }
  group.scale.setScalar(o.scale);
  return group;
}

export const PLAYER_LOOK: AirplaneLook = { scale: 10 * SCALE, bodyColor: 0xeaf6ff, accentColor: 0x31d6ff, ring: null };
export const FIGHTER_LOOK: AirplaneLook = { scale: 8.8 * SCALE, bodyColor: 0xf5a097, accentColor: 0xff4a36, ring: 0xff503d };
export const ACE_LOOK: AirplaneLook = { scale: 10 * SCALE, bodyColor: 0xffdfd3, accentColor: 0xffd23f, ring: 0xff503d };

/** A gun round as its tracer: a glowing streak along -Z. */
export function tracer(color: number, length: number): THREE.Group {
  const g = new THREE.Group();
  const streak = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, length), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
  streak.position.z = length * 0.5;
  const head = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), new THREE.MeshBasicMaterial({ color: 0xfff3a1, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending }));
  g.add(streak, head);
  return g;
}

/** createMissileProjectileVisual: the body cone, its flame and the start of
 *  its trail, forward -Z. */
export function missile(): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ConeGeometry(2.8 * SCALE, 13 * SCALE, 6), new THREE.MeshStandardMaterial({ color: 0xf4f7ff, emissive: 0xff7b35, emissiveIntensity: 1.2 }));
  body.rotation.x = -Math.PI / 2;
  const flame = new THREE.Mesh(new THREE.SphereGeometry(3.6 * SCALE, 6, 4), new THREE.MeshBasicMaterial({ color: 0xff9f2f, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
  flame.position.z = 7.5 * SCALE;
  // setCylinderBetween(84 m behind, 9 m behind): the wide end at the front
  const trail = new THREE.Mesh(
    new THREE.CylinderGeometry(1.35 * SCALE, 0.55 * SCALE, 75 * SCALE, 6, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending }),
  );
  trail.rotation.x = -Math.PI / 2;
  trail.position.z = 46.5 * SCALE;
  g.add(body, flame, trail);
  return g;
}
