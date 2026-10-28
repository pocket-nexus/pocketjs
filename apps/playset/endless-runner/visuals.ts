// Endless Runner's models, ported from GameBlocks' endless-runner demo
// (https://gb-endless-runner.vercel.app/src/Player.js, Obstacle.js,
// Collectible.js, World.js; MIT, xt4d/GameBlocks).
//
// The factories keep the demo's three.js calls and object-canonical axes
// (+X right, +Y up, -Z forward); only the import moved to the playset facade.
// Deviations: segment counts are lowered for the console (spheres, tori,
// cones and cylinders by about half), the road markings are their top faces
// (planes) instead of 4 cm boxes, the boost star is a flat prism without
// its bevel, the instanced track runs as 34 m pieces the game recycles
// ahead of the runner (panel bands every 14.2 m instead of 14 m), and the
// scenery's random shapes (tree tiers, ornaments, gifts) come in a few
// variants built once instead of one mesh per prop.

import * as THREE from "@pocketjs/framework/playset/three";
import type { Random } from "../kit/random.ts";

export const LANES = [-3.2, 0, 3.2] as const;
export const TRACK_HALF_WIDTH = 5.6;
export const SKY = 0xdff6ff;

const std = (color: number, o: { emissive?: number; emissiveIntensity?: number } = {}) => new THREE.MeshStandardMaterial({ color, ...o });

export const MAT = {
  road: std(0x26384e),
  roadPanel: std(0x3c5369),
  lane: std(0xffffff),
  laneGlow: std(0xfff3a6, { emissive: 0xb76b00, emissiveIntensity: 0.34 }),
  snow: std(0xf4fbff),
  snowBlue: std(0xd7effa),
  shoulder: std(0xd92c3a),
  shoulderWhite: std(0xffffff),
  rail: std(0xb9f4ff, { emissive: 0x2a9fc0, emissiveIntensity: 0.34 }),
  treeA: std(0x0d6b49),
  treeB: std(0x11835f),
  treeC: std(0x1f9f6a),
  trunk: std(0x7f5539),
  candyRed: std(0xd92c3a),
  giftGreen: std(0x138a66),
  gold: std(0xffd166, { emissive: 0x583800, emissiveIntensity: 0.24 }),
  sign: std(0x23374f),
  beacon: std(0xfff1aa, { emissive: 0xffc34a, emissiveIntensity: 0.75 }),
};

// --- the runner -------------------------------------------------------------

const PLAYER = { suit: 0xd92c3a, suitDark: 0x0f7f5f, head: 0xffcf8a, visor: 0x10243d, trim: 0xf6f7eb, accent: 0xffd166, shadow: 0x121a2a };

/** The runner under a "body" joint (the bob); `squash` scales it on y the
 *  way the demo squashes it while sliding. */
export function runner(squash = 1): THREE.Group {
  const body = new THREE.Joint("body");
  const bodyMat = std(PLAYER.suit);
  const sideMat = std(PLAYER.suitDark);
  const headMat = std(PLAYER.head);
  const visorMat = std(PLAYER.visor, { emissive: 0x061425 });
  const trimMat = std(PLAYER.trim);
  const accentMat = std(PLAYER.accent, { emissive: 0x3b0713 });
  const shoeMat = std(PLAYER.shadow);
  const add = (mesh: THREE.Mesh, x: number, y: number, z: number) => {
    mesh.position.set(x, y, z);
    body.add(mesh);
    return mesh;
  };
  add(new THREE.Mesh(new THREE.BoxGeometry(0.88, 1.08, 0.56), bodyMat), 0, 0.8, 0);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.36, 0.05), trimMat), 0, 0.98, -0.31);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.72, 0.18), sideMat), 0, 0.88, 0.39);
  add(new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 7), headMat), 0, 1.55, 0);
  add(new THREE.Mesh(new THREE.TorusGeometry(0.43, 0.035, 4, 14), trimMat), 0, 1.56, 0).rotation.x = Math.PI * 0.5;
  add(new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.12, 0.16), sideMat), 0, 1.22, -0.25);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.18, 0.08), visorMat), 0, 1.58, -0.37);
  add(new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.58, 10), bodyMat), 0.02, 2.0, 0.02).rotation.z = -0.18;
  add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 6, 4), trimMat), -0.06, 2.28, 0.03);
  for (const x of [-0.64, 0.64]) {
    add(new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5), accentMat), x, 1.08, -0.02);
    add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.62, 6), sideMat), x, 0.74, -0.02).rotation.z = x < 0 ? -0.22 : 0.22;
  }
  for (const x of [-0.28, 0.28]) {
    add(new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.44, 0.2), sideMat), x, 0.34, 0.02);
    add(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.58), shoeMat), x, 0.08, -0.05);
  }
  const group = new THREE.Group();
  group.add(body);
  group.scale.set(1, squash, 1);
  return group;
}

// --- obstacles --------------------------------------------------------------

export type ObstacleType = "block" | "barrier" | "lowBeam";

export const OBSTACLES: Record<ObstacleType, { color: number; accent: number; trim: number; size: { right: number; up: number; forward: number }; height: number }> = {
  block: { color: 0xd92c3a, accent: 0x0f7f5f, trim: 0xffd166, size: { right: 1.35, up: 1.55, forward: 1.1 }, height: 0 },
  barrier: { color: 0xd92c3a, accent: 0x244157, trim: 0xffffff, size: { right: 1.55, up: 0.85, forward: 1.0 }, height: 0 },
  lowBeam: { color: 0x138a66, accent: 0xffd166, trim: 0xffffff, size: { right: 1.75, up: 0.55, forward: 1.05 }, height: 1.18 },
};

export function obstacle(type: ObstacleType): THREE.Group {
  const config = OBSTACLES[type];
  const group = new THREE.Group();
  const s = config.size;
  if (type === "barrier") {
    const panelMat = std(config.color, { emissive: 0x3d0710 });
    const darkMat = std(config.accent);
    const trimMat = std(config.trim);
    for (const x of [-0.62, 0.62]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.86, 0.28), darkMat);
      post.position.set(x, 0.43, 0);
      group.add(post);
    }
    for (const y of [0.28, 0.62]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.18, 0.18), y > 0.4 ? panelMat : trimMat);
      rail.position.set(0, y, -0.08);
      group.add(rail);
    }
    for (const x of [-0.34, 0.34]) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.68, 0.04), trimMat);
      stripe.position.set(x, 0.45, -0.2);
      stripe.rotation.z = x < 0 ? -0.58 : 0.58;
      group.add(stripe);
    }
    for (const x of [-0.08, 0.08]) {
      const slash = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.82, 0.045), panelMat);
      slash.position.set(x, 0.45, -0.24);
      slash.rotation.z = x < 0 ? 0.58 : -0.58;
      group.add(slash);
    }
    return group;
  }
  if (type === "lowBeam") {
    const beamMat = std(config.color, { emissive: 0x171032 });
    const glowMat = std(config.accent, { emissive: config.accent, emissiveIntensity: 0.28 });
    const trimMat = std(config.trim);
    const snowMat = std(0xffffff);
    const top = new THREE.Mesh(new THREE.BoxGeometry(s.right, s.up, s.forward), beamMat);
    top.position.y = s.up * 0.5;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(s.right * 0.86, 0.08, s.forward * 1.04), glowMat);
    strip.position.y = s.up * 0.5;
    const frost = new THREE.Mesh(new THREE.BoxGeometry(s.right * 0.96, 0.1, s.forward * 0.86), snowMat);
    frost.position.y = s.up + 0.08;
    group.add(top, strip, frost);
    for (const x of [-0.82, 0.82]) {
      const upright = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.12, 0.22), beamMat);
      upright.position.set(x, -0.55, 0);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.42), trimMat);
      foot.position.set(x, -1.08, 0);
      group.add(upright, foot);
    }
    return group;
  }
  const shellMat = std(config.color);
  const darkMat = std(config.accent);
  const trimMat = std(config.trim);
  const snowMat = std(0xffffff);
  const base = new THREE.Mesh(new THREE.BoxGeometry(s.right, s.up, s.forward), shellMat);
  base.position.y = s.up * 0.5;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(s.right * 0.86, 0.16, s.forward * 0.86), trimMat);
  cap.position.y = s.up + 0.08;
  const snowCap = new THREE.Mesh(new THREE.BoxGeometry(s.right * 0.98, 0.08, s.forward * 0.94), snowMat);
  snowCap.position.y = s.up + 0.2;
  const ribbon = new THREE.Mesh(new THREE.BoxGeometry(0.18, s.up * 1.03, s.forward * 1.06), trimMat);
  ribbon.position.y = s.up * 0.5;
  group.add(base, cap, snowCap, ribbon);
  for (const x of [-0.52, 0.52]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.11, s.up * 0.88, s.forward * 1.04), darkMat);
    band.position.set(x, s.up * 0.5, 0);
    group.add(band);
  }
  for (const y of [0.48, 1.04]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(s.right * 0.78, 0.1, 0.045), trimMat);
    stripe.position.set(0, y, -s.forward * 0.52);
    group.add(stripe);
  }
  const bow = new THREE.Mesh(new THREE.BoxGeometry(s.right * 0.56, 0.12, 0.18), trimMat);
  bow.position.set(0, s.up + 0.31, 0);
  group.add(bow);
  return group;
}

// --- collectibles -------------------------------------------------------------

/** The coin: a gold ornament with a rim, a ribbon and a hanger, spinning. */
export function coin(): THREE.Group {
  const spin = new THREE.Joint("spin");
  const material = std(0xffd447, { emissive: 0x684800, emissiveIntensity: 0.35 });
  const rimMat = std(0xf8f7ef);
  const ribbonMat = std(0xd92c3a, { emissive: 0x3d0710 });
  spin.add(new THREE.Mesh(new THREE.SphereGeometry(0.36, 8, 5), material));
  spin.add(new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.028, 3, 12), rimMat));
  const ribbon = new THREE.Mesh(new THREE.TorusGeometry(0.365, 0.022, 3, 12), ribbonMat);
  ribbon.rotation.x = Math.PI * 0.5;
  spin.add(ribbon);
  const hanger = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.1, 6), rimMat);
  hanger.position.y = 0.38;
  spin.add(hanger);
  const group = new THREE.Group();
  group.add(spin);
  return group;
}

/** The boost: a gold star (the demo's ExtrudeGeometry, as a prism) in two rings. */
export function boost(): THREE.Group {
  const spin = new THREE.Joint("spin");
  const pts: [number, number][] = [];
  for (let point = 0; point < 10; point++) {
    const radius = point % 2 === 0 ? 0.5 : 0.22;
    const angle = Math.PI * 0.5 + point * Math.PI * 0.2;
    pts.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  const d = 0.085;
  const tri: number[] = [];
  for (let i = 0; i < 10; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % 10];
    // front (+z) and back faces, fanned from the centre
    tri.push(0, 0, d, ax, ay, d, bx, by, d);
    tri.push(0, 0, -d, bx, by, -d, ax, ay, -d);
    // the side between the two outlines
    tri.push(ax, ay, d, ax, ay, -d, bx, by, -d);
    tri.push(ax, ay, d, bx, by, -d, bx, by, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(tri), 3));
  spin.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x8f5600, emissiveIntensity: 0.8, flatShading: true })));
  const ringMat = std(0xf6f7eb, { emissive: 0xffd166, emissiveIntensity: 0.22 });
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.025, 4, 16), ringMat);
  ringA.rotation.x = Math.PI * 0.5;
  const ringB = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.025, 4, 16), ringMat);
  ringB.rotation.y = Math.PI * 0.5;
  spin.add(ringA, ringB);
  const group = new THREE.Group();
  group.add(spin);
  return group;
}

// --- the track ----------------------------------------------------------------

/** A track piece: short enough that per-vertex fog stays right along its
 *  long strips. Five pieces leapfrog 170 m at a time, a whole number of the
 *  demo's dash (8.5 m) and stripe (10 m) spacings. */
export const SEGMENT = 34;
export const SEGMENTS = 5;

/** The demo's buildTrack from forward `phase` to `phase + SEGMENT`, its
 *  start at local z = 0 and its end at z = -SEGMENT. */
export function trackSegment(phase: number): THREE.Group {
  const group = new THREE.Group();
  const L = SEGMENT;
  const strip = (w: number, h: number, mat: THREE.Material, x: number, y: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, L), mat);
    m.position.set(x, y, -L / 2);
    group.add(m);
  };
  const flat = (w: number, d: number, mat: THREE.Material, x: number, y: number, z: number, yaw = 0) => {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    group.add(m);
  };
  // markings at forward start + k * spacing that fall inside this piece
  const each = (start: number, spacing: number, fn: (local: number, index: number) => void) => {
    let k = Math.ceil((phase - start) / spacing);
    for (let f = start + k * spacing; f < phase + L; f = start + ++k * spacing) fn(f - phase, k);
  };
  flat(160, L, MAT.snow, 0, -0.03, -L / 2);
  strip(TRACK_HALF_WIDTH * 2, 0.12, MAT.road, 0, -0.06);
  // road panel bands, 12 per 170 m (the demo: every 14 m)
  each(5, 170 / 12, (f) => flat(TRACK_HALF_WIDTH * 2 - 1, 0.1, MAT.roadPanel, 0, 0.025, -f));
  for (const x of [-TRACK_HALF_WIDTH - 0.42, TRACK_HALF_WIDTH + 0.42]) strip(0.5, 0.05, MAT.shoulder, x, 0.015);
  // candy stripes on the shoulders every 10 m, alternately turned
  each(5, 10, (f, k) => {
    for (const x of [-TRACK_HALF_WIDTH - 0.42, TRACK_HALF_WIDTH + 0.42]) flat(0.54, 2.8, MAT.shoulderWhite, x, 0.081, -f, k % 2 === 0 ? 0.42 : -0.42);
  });
  for (const x of [-TRACK_HALF_WIDTH - 6.7, TRACK_HALF_WIDTH + 6.7]) flat(10.2, L, MAT.snowBlue, x, 0.003, -L / 2);
  for (const x of [-TRACK_HALF_WIDTH - 1.12, TRACK_HALF_WIDTH + 1.12]) {
    strip(1.05, 0.34, MAT.snowBlue, x, 0.09);
    strip(1.18, 0.12, MAT.snow, x, 0.31);
  }
  for (const x of [-1.6, 1.6]) flat(0.08, L, MAT.lane, x, 0.0425, -L / 2);
  // lane dashes every 8.5 m
  each(3, 8.5, (f) => {
    for (const x of [-1.6, 1.6]) flat(0.18, 2.4, MAT.laneGlow, x, 0.0745, -f);
  });
  for (const x of [-TRACK_HALF_WIDTH, TRACK_HALF_WIDTH]) {
    strip(0.22, 0.42, MAT.rail, x, 0.21);
    strip(0.34, 0.08, MAT.laneGlow, x, 0.46);
  }
  return group;
}

// --- far stand-ins ------------------------------------------------------------
// Beyond 30 m (items) and 45 m (scenery) a prop is a few pixels tall under the
// fog; the game swaps these in there, so the full models are only drawn near.

/** An obstacle beyond 40 m: its body and its top in the demo's colours. */
export function obstacleFar(type: ObstacleType): THREE.Group {
  const c = OBSTACLES[type];
  const s = c.size;
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(s.right, s.up, s.forward), std(c.color, { emissive: type === "lowBeam" ? 0x171032 : 0 }));
  body.position.y = s.up * 0.5;
  const top = new THREE.Mesh(new THREE.BoxGeometry(s.right * 0.96, 0.1, s.forward * 0.9), std(0xffffff));
  top.position.y = s.up + 0.08;
  group.add(body, top);
  if (type === "lowBeam") {
    for (const x of [-0.82, 0.82]) {
      const upright = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.12, 0.22), std(c.color));
      upright.position.set(x, -0.55, 0);
      group.add(upright);
    }
  }
  return group;
}

export function coinFar(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.SphereGeometry(0.4, 6, 4), std(0xffd447, { emissive: 0x684800, emissiveIntensity: 0.35 })));
  return group;
}

export function boostFar(): THREE.Group {
  const full = boost();
  const spin = full.children[0];
  // the star alone, without its rings
  spin.children.splice(1);
  return full;
}

export function treeFar(crown: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, 1.55, 4, 1, true), MAT.trunk);
  trunk.position.y = 0.72;
  group.add(trunk);
  for (const [radius, height, y] of [[1.05, 1.2, 1.45], [0.78, 1.0, 2.05], [0.5, 0.75, 2.58]]) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(radius, height, 5, 1, true), crown);
    c.position.y = y;
    group.add(c);
  }
  return group;
}

export function archFar(): THREE.Group {
  const group = new THREE.Group();
  for (const x of [-0.46, 0.46]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.08, 1.44, 4, 1, true), MAT.candyRed);
    post.position.set(x, 0.78, 0);
    group.add(post);
  }
  const arch = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.07, 3, 6, Math.PI), MAT.snow);
  arch.position.set(0, 1.52, 0);
  arch.rotation.z = Math.PI;
  group.add(arch);
  return group;
}

export function beaconFar(): THREE.Group {
  const pole = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.28, 0.16), MAT.sign);
  pole.position.y = 0.64;
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.34), MAT.beacon);
  lamp.position.y = 1.42;
  const group = new THREE.Group();
  group.add(pole, lamp);
  return group;
}

export function clusterFar(): THREE.Group {
  const group = new THREE.Group();
  const mound = new THREE.Mesh(new THREE.SphereGeometry(0.92, 6, 3), MAT.snowBlue);
  mound.position.y = 0.1;
  mound.scale.set(1.25, 0.24, 0.78);
  const gift = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), MAT.candyRed);
  gift.position.set(0, 0.5, 0);
  group.add(mound, gift);
  return group;
}

// --- scenery ----------------------------------------------------------------

/** A canopy tree: a trunk, three snow-capped tiers and four ornaments. */
export function canopyTree(random: Random, crown: THREE.Material, large: boolean): THREE.Group {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.24, 1.55, 6), MAT.trunk);
  trunk.position.y = 0.72;
  group.add(trunk);
  const k = large ? 1.12 : 0.9;
  const tiers = [
    { radius: 1.05 * k, height: 1.2, y: 1.45 },
    { radius: 0.78 * k, height: 1.0, y: 2.05 },
    { radius: 0.5 * k, height: 0.75, y: 2.58 },
  ];
  for (const tier of tiers) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(tier.radius, tier.height, 7), crown);
    c.position.y = tier.y;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(tier.radius * 0.78, tier.height * 0.3, 7), MAT.snow);
    cap.position.y = tier.y + tier.height * 0.28;
    group.add(c, cap);
  }
  const ornaments = [MAT.candyRed, MAT.gold, MAT.beacon];
  for (let index = 0; index < 4; index++) {
    const o = new THREE.Mesh(new THREE.OctahedronGeometry(0.08), random.pick(ornaments));
    const angle = random.uniform(0, Math.PI * 2);
    const radius = random.uniform(0.28, 0.66);
    o.position.set(Math.cos(angle) * radius, random.uniform(1.65, 2.35), Math.sin(angle) * radius);
    group.add(o);
  }
  return group;
}

/** The candy-cane arch ("neon sign"); `side` turns its bow toward the road. */
export function candyArch(side: number): THREE.Group {
  const group = new THREE.Group();
  for (const x of [-0.46, 0.46]) {
    for (let index = 0; index < 6; index++) {
      const segment = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.24, 6, 1, true), index % 2 === 0 ? MAT.candyRed : MAT.snow);
      segment.position.set(x, 0.18 + index * 0.24, 0);
      segment.rotation.z = x < 0 ? -0.08 : 0.08;
      group.add(segment);
    }
  }
  const arch = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.07, 6, 12, Math.PI), MAT.snow);
  arch.position.set(0, 1.52, 0);
  arch.rotation.z = Math.PI;
  group.add(arch);
  for (const x of [-0.28, 0, 0.28]) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.22, 0.1), MAT.candyRed);
    stripe.position.set(x, 1.82 - Math.abs(x) * 0.46, 0.02);
    stripe.rotation.z = 0.42;
    group.add(stripe);
  }
  const bow = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.12, 0.08), MAT.gold);
  bow.position.set(0, 0.92, side < 0 ? 0.05 : -0.05);
  bow.rotation.y = side < 0 ? 0.22 : -0.22;
  group.add(bow);
  return group;
}

export function beacon(): THREE.Group {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 1.28, 6), MAT.sign);
  pole.position.y = 0.64;
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.42), MAT.candyRed);
  base.position.y = 0.08;
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.34), MAT.beacon);
  lamp.position.y = 1.42;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.24, 6), MAT.snow);
  cap.position.y = 1.78;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.018, 4, 12), MAT.gold);
  ring.position.y = 1.42;
  ring.rotation.x = Math.PI * 0.5;
  const group = new THREE.Group();
  group.add(base, pole, lamp, cap, ring);
  return group;
}

/** A snow mound with `gifts` wrapped boxes and two snowballs. */
export function rockCluster(random: Random, gifts: number): THREE.Group {
  const group = new THREE.Group();
  const mound = new THREE.Mesh(new THREE.SphereGeometry(0.92, 10, 5), MAT.snowBlue);
  mound.position.y = 0.1;
  mound.scale.set(1.25, 0.24, 0.78);
  group.add(mound);
  const giftMats = [MAT.candyRed, MAT.giftGreen, MAT.gold];
  for (let index = 0; index < gifts; index++) {
    const size = random.uniform(0.28, 0.5);
    const gift = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), random.pick(giftMats));
    gift.position.set(random.uniform(-0.55, 0.55), 0.28 + size * 0.5, random.uniform(-0.38, 0.38));
    gift.rotation.y = random.uniform(-0.35, 0.35);
    const ribbon = new THREE.Mesh(new THREE.BoxGeometry(size * 0.18, size * 1.08, size * 1.08), MAT.snow);
    ribbon.position.copy(gift.position);
    ribbon.rotation.copy(gift.rotation);
    const bow = new THREE.Mesh(new THREE.BoxGeometry(size * 0.55, size * 0.11, size * 0.2), MAT.snow);
    bow.position.copy(gift.position);
    bow.position.y += size * 0.58;
    bow.rotation.copy(gift.rotation);
    group.add(gift, ribbon, bow);
  }
  for (let index = 0; index < 2; index++) {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(random.uniform(0.16, 0.25), 6, 4), MAT.snow);
    ball.position.set(random.uniform(-0.75, 0.75), 0.22, random.uniform(-0.48, 0.48));
    group.add(ball);
  }
  return group;
}
