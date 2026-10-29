// ported from GameBlocks' archery-hunting (https://gb-archery-hunting.vercel.app/, MIT, xt4d/GameBlocks)
//
// The demo's visual factories (src/game.js, NaturalEnvironment,
// PlantVisualFactory, RockVisualFactory, TerrainSampler) on the playset
// three.js facade. Deviations, all for the Old 3DS vertex budget:
//   - canopies are smooth-shaded with 7 radial segments instead of faceted
//     with 9, broadleaf crowns are three icosahedra (60 vertices each)
//     instead of four dodecahedra (108), trunks and flares are open 5-6
//     sided tubes, ring boards have 10/8/6 sides instead of 48;
//   - the bow limb is a 12-sample tube instead of 72, its string two
//     segments on joints;
//   - the target zone marker follows the terrain (a fan of triangles)
//     instead of a flat 48-sided disc;
//   - targets face -Z (their direction of travel) instead of turning their
//     +Z toward the player: animals walk where they look.
//
// Coordinates: the demo's basis is right +x, up +z, forward +y; here right is
// +X, up +Y and forward -Z, so the demo's (right r, forward f) is (r, -f).

import * as THREE from "@pocketjs/framework/playset/three";
import type { Random } from "../kit/random.ts";

/** NaturalTerrainSampler.heightAt with undulation 3.6 and hill frequency 1. */
export function terrainHeight(x: number, z: number): number {
  return Math.sin(x * 0.055) * Math.cos(z * 0.047) * 2.2 + Math.sin((x - z) * 0.022) * 1.4;
}

export const TERRAIN_SIZE = 180;

/** FirstPersonCameraRig's eye height above the hunter's feet */
export const EYE = 1.64;

export const T_RING = 0;
export const T_ANIMAL = 1;
export const T_CREATURE = 2;
/** per target type: body sphere centre above the ground and hit radius
 *  (findArrowHit), weak spot height and base value (spawnTarget) */
export const TARGET_SHAPE = [
  { body: 1.35, radius: 0.85, weak: 1.8, value: 110 },
  { body: 0.9, radius: 0.95, weak: 0.95, value: 170 },
  { body: 0.9, radius: 1.3, weak: 1.34, value: 240 },
] as const;

export const PALETTE = {
  skyTop: 0x90c8da,
  skyHorizon: 0xd8d5b2,
  skyLower: 0x9bc8ab,
  fog: 0xb8d6d2,
  grassLow: 0x639b4f,
  grassHigh: 0x8fa55f,
  zone: 0xf1d172,
};

// --- the forest ---------------------------------------------------------------

export interface TreeMaterials {
  trunk: THREE.Material;
  barkShadow: THREE.Material;
  leaves: THREE.Material[];
}

export function treeMaterials(): TreeMaterials {
  return {
    trunk: new THREE.MeshStandardMaterial({ color: 0x6d472b }),
    barkShadow: new THREE.MeshStandardMaterial({ color: 0x3f281b }),
    leaves: [0x245d3a, 0x3f783f, 0x6e8f3a, 0x8fa65a].map((color) => new THREE.MeshStandardMaterial({ color })),
  };
}

/** createTreeVisual: the same draws from `prng` as the demo, so a seed gives
 *  the demo's forest. */
export function tree(height: number, radius: number, materials: TreeMaterials, prng: Random): THREE.Group {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.58, radius * 1.03, height, 5, 1, true), materials.trunk);
  trunk.position.y = height * 0.5;
  group.add(trunk);
  const flare = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.35, radius * 1.7, Math.max(0.18, radius * 0.52), 6, 1, true),
    materials.barkShadow,
  );
  flare.position.y = Math.max(0.09, radius * 0.26);
  group.add(flare);
  if (prng() < 0.52) {
    const count = prng() < 0.45 ? 2 : 1;
    for (let i = 0; i < count; i++) group.add(branchStub(height, radius, prng, materials.barkShadow));
  }
  if (prng() < 0.74) coniferCanopy(group, height, prng, materials.leaves);
  else broadleafCanopy(group, height, prng, materials.leaves);
  return group;
}

function branchStub(height: number, radius: number, prng: Random, material: THREE.Material): THREE.Mesh {
  const length = prng.uniform(0.48, 0.88);
  const branch = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.13, radius * 0.2, length, 4, 1, true), material);
  const angle = prng.uniform(0, Math.PI * 2);
  const lean = prng.uniform(0.74, 0.98);
  const dx = Math.cos(angle) * lean;
  const dy = prng.uniform(0.22, 0.42);
  const dz = Math.sin(angle) * lean;
  const l = Math.hypot(dx, dy, dz);
  branch.position.set((dx / l) * length * 0.34, height * prng.uniform(0.48, 0.68), (dz / l) * length * 0.34);
  // quaternion.setFromUnitVectors(+Y, dir) as a yaw then a tilt
  branch.rotation.set(0, Math.atan2(dx, dz), 0, "YXZ");
  branch.rotation.x = Math.acos(Math.max(-1, Math.min(1, dy / l)));
  return branch;
}

function coniferCanopy(group: THREE.Group, height: number, prng: Random, leaves: THREE.Material[]): void {
  const base = prng.uniform(1.85, 3.3) * THREE.MathUtils.clamp(height / 7.6, 0.82, 1.18);
  const layers = [
    { y: height * 0.68, radius: base, height: height * prng.uniform(0.44, 0.56) },
    { y: height * 0.88, radius: base * prng.uniform(0.72, 0.84), height: height * prng.uniform(0.36, 0.48) },
    { y: height * 1.06, radius: base * prng.uniform(0.48, 0.62), height: height * prng.uniform(0.28, 0.38) },
  ];
  for (const layer of layers) {
    const crown = new THREE.Mesh(new THREE.ConeGeometry(layer.radius, layer.height, 7, 1, true), prng.pick(leaves));
    crown.position.y = layer.y;
    crown.rotation.y = prng.uniform(0, Math.PI * 2);
    crown.scale.set(prng.uniform(0.88, 1.12), 1, prng.uniform(0.88, 1.12));
    group.add(crown);
  }
}

function broadleafCanopy(group: THREE.Group, height: number, prng: Random, leaves: THREE.Material[]): void {
  const size = prng.uniform(1.25, 2.0) * THREE.MathUtils.clamp(height / 7.2, 0.85, 1.25);
  const clusters = [
    { x: 0, y: height * 0.93, z: 0, scale: 1.25 },
    { x: -size * 0.45, y: height * 0.82, z: size * 0.12, scale: 0.86 },
    { x: size * 0.42, y: height * 0.84, z: -size * 0.18, scale: 0.8 },
    { x: size * 0.06, y: height * 1.08, z: -size * 0.05, scale: 0.72 },
  ];
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i];
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(size * c.scale, 0), prng.pick(leaves));
    crown.position.set(c.x, c.y, -c.z);
    crown.rotation.set(prng.uniform(-0.2, 0.2), prng.uniform(0, Math.PI * 2), prng.uniform(-0.2, 0.2));
    crown.scale.set(prng.uniform(0.95, 1.18), prng.uniform(0.78, 1.08), prng.uniform(0.92, 1.18));
    // the smallest, topmost crown is drawn only for its draws from prng
    if (i < 3) group.add(crown);
  }
}

/** createGrassBladeVisual; its turn is the placement's yaw. */
export function grassBlade(material: THREE.Material, height: number): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.ConeGeometry(0.08, height, 3, 1, true), material));
  return group;
}

export function groundRock(material: THREE.Material, prng: Random): THREE.Group {
  const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(prng.uniform(0.7, 2.0), 0), material);
  rock.scale.y = prng.uniform(0.35, 0.8);
  rock.rotation.set(prng() * Math.PI, prng() * Math.PI, prng() * Math.PI);
  const group = new THREE.Group();
  group.add(rock);
  return group;
}

/** A target zone's marker lying on the terrain around (cx, cz): a centre fan
 *  and one outer ring of triangles, each vertex at the ground plus 0.12. */
export function zoneMarker(cx: number, cz: number, radius: number): THREE.Group {
  const seg = 14;
  const inner = radius * 0.55;
  const tris: number[] = [];
  const at = (r: number, k: number): [number, number, number] => {
    const a = (k / seg) * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    return [x, terrainHeight(cx + x, cz + z) + 0.12, z];
  };
  const centre: [number, number, number] = [0, terrainHeight(cx, cz) + 0.12, 0];
  for (let k = 0; k < seg; k++) {
    const a0 = at(inner, k), a1 = at(inner, k + 1);
    const b0 = at(radius, k), b1 = at(radius, k + 1);
    // counter-clockwise seen from above (+Y): angle runs from +X toward +Z
    tris.push(...centre, ...a1, ...a0);
    tris.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(tris), 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: PALETTE.zone, transparent: true, opacity: 0.3 }));
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}

// --- targets ------------------------------------------------------------------

export type TargetType = "ring" | "animal" | "creature";

/** buildRingTarget: a post and a three-ring board facing -Z. */
export function ringTarget(): THREE.Group {
  const group = new THREE.Group();
  const stand = new THREE.MeshStandardMaterial({ color: 0x6b4328 });
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.0, 6, 1, true), stand);
  post.position.y = 1.0;
  const rings: [number, number, number, number][] = [
    [0.9, 0.12, 0xf7f2d2, 10],
    [0.56, 0.13, 0xd74432, 8],
    [0.24, 0.14, 0xf1d172, 6],
  ];
  group.add(post);
  for (const [r, h, color, seg] of rings) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), new THREE.MeshStandardMaterial({ color }));
    disc.position.y = 1.8;
    disc.rotation.x = Math.PI * 0.5;
    group.add(disc);
  }
  return group;
}

/** buildAnimalTarget, turned so the head leads along -Z; the legs swing on
 *  two joints while it walks. */
export function animalTarget(): THREE.Group {
  const group = new THREE.Group();
  const fur = new THREE.MeshStandardMaterial({ color: 0x93633e });
  const dark = new THREE.MeshStandardMaterial({ color: 0x3b281e });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.72, 10, 7), fur);
  body.scale.set(0.7, 0.75, 1.45);
  body.position.y = 0.82;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 6), fur);
  head.position.set(0, 1.02, -0.88);
  const legGeo = new THREE.CylinderGeometry(0.055, 0.065, 0.72, 5, 1, true);
  for (const [name, z] of [["front", -0.42], ["back", 0.42]] as const) {
    const hip = new THREE.Joint(name);
    hip.position.set(0, 0.7, z);
    for (const x of [-0.24, 0.24]) {
      const leg = new THREE.Mesh(legGeo, dark);
      leg.position.set(x, -0.36, 0);
      hip.add(leg);
    }
    group.add(hip);
  }
  group.add(body, head);
  return group;
}

/** buildCreatureTarget: the glowing forest warden, its core at the front. */
export function creatureTarget(): THREE.Group {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0x446ec9, emissive: 0x102651, emissiveIntensity: 0.45 });
  const bright = new THREE.MeshStandardMaterial({ color: 0xaee8ff, emissive: 0x56cfff, emissiveIntensity: 1.2 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.88, 12, 8), skin);
  body.scale.set(1, 1.35, 0.82);
  body.position.y = 1.22;
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), bright);
  core.position.set(0, 1.34, -0.7);
  const antlerGeo = new THREE.ConeGeometry(0.06, 0.9, 6);
  for (const x of [-0.36, 0.36]) {
    const antler = new THREE.Mesh(antlerGeo, bright);
    antler.position.set(x, 2.28, 0);
    antler.rotation.z = -x;
    group.add(antler);
  }
  group.add(body, core);
  return group;
}

// --- the bow and arrows ----------------------------------------------------------

/** The bow's string ends and nock in its model frame (bowStringTop, Nock, Bottom). */
export const STRING = { x: -0.12, top: 0.58, z: -0.045 };
/** bowGroup's place in the camera frame and its scale; bowModelGroup's yaw. */
export const BOW = { x: 0.8, y: -0.2, z: -1.18, scale: 1.3, yaw: Math.PI * 0.03 };
/** how far the string pulls back at full draw */
export const PULL = 0.335;
const STRING_LENGTH = 0.62;

/** createBow + createBowBody: the limb as a tube along a quadratic Bezier,
 *  the string as two segments hanging from joints at the limb tips. The root
 *  is the camera: the model carries bowGroup's offset and scale. */
export function bow(): THREE.Group {
  const wood = new THREE.MeshStandardMaterial({ color: 0x7e4f2d });
  const cord = new THREE.MeshStandardMaterial({ color: 0xd9c79f, emissive: 0xd9c79f, emissiveIntensity: 0.25 });
  const samples = 12;
  const ring = 4;
  const p0 = [STRING.x, STRING.top, STRING.z];
  const p1 = [0.26, 0, -1.3];
  const p2 = [STRING.x, -STRING.top, STRING.z];
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    const c = [0, 1, 2].map((k) => u * u * p0[k] + 2 * u * t * p1[k] + t * t * p2[k]);
    const tan = [0, 1, 2].map((k) => 2 * u * (p1[k] - p0[k]) + 2 * t * (p2[k] - p1[k]));
    const tl = Math.hypot(tan[0], tan[1], tan[2]) || 1;
    // side = depthAxis (0,0,1) x tangent
    let sx = -tan[1] / tl;
    let sy = tan[0] / tl;
    const sl = Math.hypot(sx, sy) || 1;
    sx /= sl;
    sy /= sl;
    const grip = Math.pow(1 - Math.abs(t * 2 - 1), 0.55);
    const tip = Math.abs(t * 2 - 1);
    const hw = THREE.MathUtils.lerp(0.028, 0.064, grip);
    const hd = THREE.MathUtils.lerp(0.026, 0.042, grip) * (1 - tip * 0.18);
    const rounded = tip > 0.9 ? 0.78 : 1;
    const cross = [
      [hw * rounded, hd],
      [-hw * rounded, hd],
      [-hw * 0.92 * rounded, -hd],
      [hw * 0.92 * rounded, -hd],
    ];
    for (const [side, depth] of cross) positions.push(c[0] + sx * side, c[1] + sy * side, c[2] + depth);
    if (i < samples) {
      const row = i * ring;
      const next = row + ring;
      for (let k = 0; k < ring; k++) {
        const nk = (k + 1) % ring;
        indices.push(row + k, next + k, row + nk, row + nk, next + k, next + nk);
      }
    }
  }
  indices.push(0, 1, 2, 0, 2, 3);
  const end = samples * ring;
  indices.push(end, end + 2, end + 1, end, end + 3, end + 2);
  const limbGeo = new THREE.BufferGeometry();
  limbGeo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(positions), 3));
  limbGeo.setIndex(indices);
  const limb = new THREE.Mesh(limbGeo, wood);

  const model = new THREE.Group();
  model.rotation.y = BOW.yaw;
  model.add(limb);
  // the string: a segment down from the top tip, one up from the bottom tip;
  // joints at the tips swing them back toward the nock
  for (const [name, sign] of [["stringTop", 1], ["stringBottom", -1]] as const) {
    const pivot = new THREE.Joint(name);
    pivot.position.set(STRING.x, STRING.top * sign, STRING.z);
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, STRING_LENGTH, 3, 1, true), cord);
    seg.position.y = -sign * STRING_LENGTH * 0.5;
    pivot.add(seg);
    model.add(pivot);
  }
  const offset = new THREE.Group();
  offset.position.set(BOW.x, BOW.y, BOW.z);
  offset.scale.setScalar(BOW.scale);
  offset.add(model);
  const root = new THREE.Group();
  root.add(offset);
  return root;
}

/** heldArrowGroup: the nocked arrow, its nock at the origin, pointing -Z
 *  (turned by bowModelGroup's yaw, as the demo parents it). */
export function heldArrow(): THREE.Group {
  const shaftLength = 0.96 * 1.3;
  const tipLength = 0.12 * 1.3;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, shaftLength, 5, 1, true), new THREE.MeshStandardMaterial({ color: 0xc58b4f }));
  shaft.rotation.x = Math.PI * 0.5;
  shaft.position.z = -shaftLength * 0.5;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.035, tipLength, 6), new THREE.MeshStandardMaterial({ color: 0xdce2df, emissive: 0x30363a }));
  tip.rotation.x = -Math.PI * 0.5;
  tip.position.z = -(shaftLength + tipLength * 0.5);
  const inner = new THREE.Group();
  inner.rotation.y = BOW.yaw;
  inner.add(shaft, tip);
  const root = new THREE.Group();
  root.scale.setScalar(BOW.scale);
  root.add(inner);
  return root;
}

/** createArrow: shaft, tip and three fletches, flying along -Z. The shaft is
 *  a little thicker than the demo's so it reads at 400x240. */
export function arrow(): THREE.Group {
  const group = new THREE.Group();
  const shaftLength = 0.78 * 1.3;
  const tipLength = 0.16 * 1.3;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, shaftLength, 5, 1, true), new THREE.MeshStandardMaterial({ color: 0x8b5a2d }));
  shaft.rotation.x = Math.PI * 0.5;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05, tipLength, 5), new THREE.MeshStandardMaterial({ color: 0xd8dde0, emissive: 0x40464a }));
  tip.position.z = -(shaftLength * 0.5 + tipLength * 0.5);
  tip.rotation.x = -Math.PI * 0.5;
  const feather = new THREE.MeshStandardMaterial({ color: 0xf1d172, emissive: 0xf1d172, emissiveIntensity: 0.2 });
  for (let i = 0; i < 3; i++) {
    // the demo's fletches face back along the shaft; a plane draws one
    // side, so each is a back-to-back pair
    for (const flip of [0, Math.PI]) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.18), feather);
      f.position.z = shaftLength * 0.5 - 0.02;
      f.rotation.set(0, flip, (i * Math.PI * 2) / 3);
      group.add(f);
    }
  }
  group.add(shaft, tip);
  return group;
}

/** The demo's CSS crosshair: four short bars around the screen centre, one
 *  metre in front of the eye, facing it (+Z). */
export function crosshair(): THREE.Group {
  const tris: number[] = [];
  const quad = (x0: number, y0: number, x1: number, y1: number) => {
    tris.push(x0, y0, -1, x1, y0, -1, x1, y1, -1, x0, y0, -1, x1, y1, -1, x0, y1, -1);
  };
  // at 1 m one pixel of the top screen is about 0.005 m
  const g = 0.011, l = 0.028, t = 0.0045;
  quad(-g - l, -t, -g, t);
  quad(g, -t, g + l, t);
  quad(-t, g, t, g + l);
  quad(-t, -g - l, t, -g);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(tris), 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const group = new THREE.Group();
  group.add(mesh);
  return group;
}
