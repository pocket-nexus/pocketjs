// Pirate Seas' models, ported from GameBlocks' pirate-seas demo
// (https://gb-pirate-seas.vercel.app/, MIT, xt4d/GameBlocks).
//
// The factories keep the demo's three.js calls; only the import moved to the
// playset facade. Deviations: canvas textures are dropped, so each material
// takes its texture's base colour; segment counts are lowered for the PICA
// (rigging 3 sides, posts 4, cannons 6, palm trunks 5, puffs 6x4); palm
// fronds and halos are emitted with both windings because the playset
// renderer culls back faces; clouds are opaque so they bake into the static
// batches; the sky dome's shader gradient became the playset sky, and its
// sun-glow sprite is gone.
//
// Coordinates: the demo's basis is right +Z, forward +X. Here right is +X
// and forward -Z (the playset convention); a ship model already points its
// bow down -Z, so the factories keep their local numbers.

import * as THREE from "@pocketjs/framework/playset/three";
import type { Random } from "../kit/random.ts";

export const SHIP_SIZE_SCALE = 2;
export const ISLAND_SIZE_SCALE = 2;
export const PALM_TREE_SIZE_SCALE = 5;
export const PALMS_PER_ISLAND = 3;
export const ENEMY_SHIP_SCALE = 0.88;

/** createMaterials, with each texture's base colour folded into the material colour. */
export function createMaterials() {
  const std = (color: number, extra: THREE.MaterialParameters = {}) => new THREE.MeshStandardMaterial({ color, ...extra });
  return {
    hull: std(0x6f4429),
    hullDark: std(0x3b2117),
    enemyHull: std(0x8f2433),
    enemyDeck: std(0x5f1b28),
    enemyTrim: std(0xf0b34d, { emissive: 0x3a1004 }),
    sail: std(0xf2ead5),
    enemySail: std(0xc24a44),
    mast: std(0x80512e),
    gold: std(0xf6c84f, { emissive: 0x4a2d00 }),
    rock: std(0x6f7f79, { flatShading: true }),
    island: std(0xd3ad6c),
    grass: std(0x4f9148),
    dock: std(0x7b5432),
    trim: std(0xc99b45, { emissive: 0x2a1702 }),
    palmLeaf: std(0x348c58),
    flagPlayer: std(0x17191d),
    flagEnemy: std(0xb63d37),
    cloud: std(0xfff2dd, { emissive: 0xfff2dd, emissiveIntensity: 0.35 }),
    cannonball: std(0x16191a),
    repair: std(0xd94436, { emissive: 0x340605 }),
    ammo: std(0x394247),
    shrub: std(0x4f9148, { flatShading: true }),
  };
}

export type Materials = ReturnType<typeof createMaterials>;

/** A thin cylinder from `start` to `end` (the demo's makeLineCylinder). Euler
 *  "YZX" = Ry * Rz turns the cylinder's +Y onto the direction. */
function lineCylinder(start: THREE.Vector3, end: THREE.Vector3, radius: number, material: THREE.Material, sides = 3): THREE.Mesh {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dy, dz);
  const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, sides, 1, true), material);
  cylinder.position.set(start.x + dx / 2, start.y + dy / 2, start.z + dz / 2);
  const psi = Math.acos(Math.max(-1, Math.min(1, dy / length)));
  const phi = Math.atan2(dz, -dx);
  cylinder.rotation.set(0, phi, psi, "YZX");
  return cylinder;
}

/** makeShipMesh: hull, deck, bow, stern and cabin, two masts with sails,
 *  spars and rigging, a figurehead, a flag and three cannons a side. */
export function shipMesh(materials: Materials, enemy: boolean): THREE.Group {
  const group = new THREE.Group();
  const hullMaterial = enemy ? materials.enemyHull : materials.hull;
  const deckMaterial = enemy ? materials.enemyDeck : materials.dock;
  const trimMaterial = enemy ? materials.enemyTrim : materials.trim;
  const sailMaterial = enemy ? materials.enemySail : materials.sail;
  const flagMaterial = enemy ? materials.flagEnemy : materials.flagPlayer;
  const hull = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.15, 9), hullMaterial);
  hull.position.y = 0.58;
  group.add(hull);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(4.05, 0.16, 7.25), deckMaterial);
  deck.position.set(0, 1.2, -0.15);
  group.add(deck);

  const bow = new THREE.Mesh(new THREE.ConeGeometry(2.25, 2.6, 4), hullMaterial);
  bow.rotation.set(-Math.PI / 2, Math.PI / 4, 0);
  bow.position.set(0, 0.6, -5.4);
  group.add(bow);

  const stern = new THREE.Mesh(new THREE.BoxGeometry(4.8, 1.6, 1.4), hullMaterial);
  stern.position.set(0, 1.2, 4.4);
  group.add(stern);

  const sternRail = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.16, 0.16), trimMaterial);
  sternRail.position.set(0, 2.08, 5.18);
  group.add(sternRail);

  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 7.6), trimMaterial);
    rail.position.set(side * 2.34, 1.62, -0.3);
    group.add(rail);
    for (const z of [-3.2, -1.1, 1.1, 3.2]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.72, 4, 1, true), materials.mast);
      post.position.set(side * 2.25, 1.6, z);
      group.add(post);
    }
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.1, 8.5), trimMaterial);
    trim.position.set(side * 2.28, 0.96, -0.2);
    group.add(trim);
  }

  const cabin = new THREE.Mesh(new THREE.BoxGeometry(2.35, 1.25, 1.65), hullMaterial);
  cabin.position.set(0, 1.88, 3.15);
  group.add(cabin);
  const cabinRoof = new THREE.Mesh(new THREE.BoxGeometry(2.65, 0.18, 1.9), trimMaterial);
  cabinRoof.position.set(0, 2.58, 3.15);
  group.add(cabinRoof);

  for (const z of [-1.8, 1.6]) {
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 6.5, 6), materials.mast);
    mast.position.set(0, 3.7, z);
    group.add(mast);
    const sail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.2, 3.6), sailMaterial);
    sail.position.set(0, 3.6, z - 0.25);
    sail.rotation.y = 0.08;
    group.add(sail);
    for (const y of [2.05, 5.2]) {
      const spar = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4.35, 5, 1, true), materials.mast);
      spar.rotation.z = Math.PI / 2;
      spar.position.set(0, y, z - 0.25);
      group.add(spar);
    }
    const top = new THREE.Vector3(0, 6.75, z);
    group.add(
      lineCylinder(top, new THREE.Vector3(-1.95, 1.3, -4.25), 0.025, materials.mast),
      lineCylinder(top, new THREE.Vector3(1.95, 1.3, -4.25), 0.025, materials.mast),
      lineCylinder(top, new THREE.Vector3(-1.9, 1.3, 4.55), 0.025, materials.mast),
      lineCylinder(top, new THREE.Vector3(1.9, 1.3, 4.55), 0.025, materials.mast),
    );
  }

  const figurehead = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.9, 6), trimMaterial);
  figurehead.rotation.x = -Math.PI / 2;
  figurehead.position.set(0, 1.05, -6.72);
  group.add(figurehead);

  const flag = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.55, 0.05), flagMaterial);
  flag.position.set(0.66, 6.9, -1.8);
  group.add(flag);

  for (const side of [-1, 1]) {
    for (const z of [-2.4, 0, 2.4]) {
      const cannon = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.18, 1, 5), materials.cannonball);
      cannon.rotation.z = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      cannon.position.set(side * 2.5, 1, z);
      group.add(cannon);
    }
  }

  group.scale.setScalar((enemy ? ENEMY_SHIP_SCALE : 1) * SHIP_SIZE_SCALE);
  return group;
}

/** A raw double-sided triangle soup: the playset renderer culls back faces,
 *  and the demo's fronds and halos are DoubleSide. */
function doubleSided(positions: number[], index: number[]): THREE.BufferGeometry {
  const tri: number[] = [];
  for (let i = 0; i < index.length; i += 3) {
    const [a, b, c] = [index[i], index[i + 1], index[i + 2]];
    for (const v of [a, b, c, a, c, b]) tri.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(tri), 3));
  return geometry;
}

/** createPalmFrondGeometry, at four segments. */
function palmFrondGeometry(length: number, width: number, droop: number): THREE.BufferGeometry {
  const segments = 4;
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const halfWidth = Math.sin(t * Math.PI) * width * (1 - t * 0.18);
    const x = t * length;
    const y = -Math.sin(t * Math.PI * 0.85) * droop - t * 0.32;
    vertices.push(x, y, -halfWidth, x, y, halfWidth);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  return doubleSided(vertices, indices);
}

function palm(materials: Materials, random: Random, radius: number, index: number, count: number, angleOffset: number, islandScaleZ: number): THREE.Group {
  const group = new THREE.Group();
  const placementAngle = angleOffset + (index / count) * Math.PI * 2 + random.uniform(-0.18, 0.18);
  const placementRadius = random.uniform(radius * 0.34, radius * 0.48);
  group.position.set(Math.cos(placementAngle) * placementRadius, 1.15, Math.sin(placementAngle) * placementRadius * islandScaleZ * 0.82);
  group.rotation.z = random.uniform(-0.18, 0.18);
  for (let i = 0; i < 6; i += 1) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18 + i * 0.01, 0.28, 0.95, 5, 1, true), materials.mast);
    trunk.position.y = i * 0.72 + 0.55;
    trunk.rotation.z = random.uniform(-0.08, 0.08);
    group.add(trunk);
  }
  const crownY = 5;
  const frondCount = 7;
  for (let i = 0; i < frondCount; i += 1) {
    const angle = (i / frondCount) * Math.PI * 2 + random.uniform(-0.09, 0.09);
    const leaf = new THREE.Mesh(palmFrondGeometry(random.uniform(2.9, 3.7), random.uniform(0.38, 0.56), random.uniform(0.32, 0.62)), materials.palmLeaf);
    leaf.position.y = crownY + random.uniform(-0.08, 0.12);
    leaf.rotation.y = angle;
    leaf.rotation.z = random.uniform(-0.08, 0.08);
    group.add(leaf);
  }
  group.scale.setScalar(PALM_TREE_SIZE_SCALE);
  return group;
}

/** createIsland: a sand disc, a grass cap, three palms, shrubs and stones.
 *  Shrubs and stones are octahedra and icosahedra (the demo's dodecahedra
 *  cost three times the vertices for the same silhouette at this size). */
export function island(materials: Materials, random: Random, radius: number): THREE.Group {
  const group = new THREE.Group();
  const scaleZ = random.uniform(0.65, 1.25);
  const sand = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 1.18, 1.2, 24), materials.island);
  sand.position.y = 0.12;
  sand.scale.z = scaleZ;
  group.add(sand);
  const grass = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.72, radius * 0.82, 1.1, 20), materials.grass);
  grass.position.y = 0.9;
  grass.scale.z = scaleZ * 0.8;
  group.add(grass);
  const palmAngleOffset = random.uniform(-Math.PI, Math.PI);
  for (let i = 0; i < PALMS_PER_ISLAND; i += 1) group.add(palm(materials, random, radius, i, PALMS_PER_ISLAND, palmAngleOffset, scaleZ));
  for (let i = 0; i < 5; i += 1) {
    const shrub = new THREE.Mesh(new THREE.IcosahedronGeometry(random.uniform(0.35, 0.75) * 2, 0), materials.shrub);
    shrub.position.set(random.uniform(-radius * 0.65, radius * 0.65), 1.48, random.uniform(-radius * 0.42 * scaleZ, radius * 0.42 * scaleZ));
    shrub.scale.y = random.uniform(0.55, 0.95);
    group.add(shrub);
  }
  for (let i = 0; i < 6; i += 1) {
    const stone = new THREE.Mesh(new THREE.OctahedronGeometry(random.uniform(0.25, 0.65) * 2, 0), materials.rock);
    stone.position.set(random.uniform(-radius * 0.78, radius * 0.78), 0.95, random.uniform(-radius * 0.55 * scaleZ, radius * 0.55 * scaleZ));
    stone.rotation.set(random.uniform(0, 2), random.uniform(0, 2), random.uniform(0, 2));
    group.add(stone);
  }
  return group;
}

/** createRock: one faceted boulder, half above the water. */
export function rock(materials: Materials, random: Random, radius: number): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.DodecahedronGeometry(radius, 0), materials.rock);
  mesh.position.y = radius * 0.42;
  mesh.rotation.set(random.uniform(0, 2), random.uniform(0, 2), random.uniform(0, 2));
  mesh.scale.set(random.uniform(0.8, 1.35), random.uniform(0.65, 1.18), random.uniform(0.8, 1.25));
  mesh.userData.jitter = radius * 0.08;
  group.add(mesh);
  return group;
}

/** createCloud: puffs, stretched (five where the demo has six). */
export function cloud(materials: Materials, random: Random): THREE.Group {
  const group = new THREE.Group();
  group.scale.set(random.uniform(1.4, 2.8), random.uniform(0.62, 0.95), random.uniform(0.8, 1.4));
  for (let i = 0; i < 5; i += 1) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(random.uniform(3, 7), 6, 4), materials.cloud);
    puff.position.set(random.uniform(-9, 9), random.uniform(-1, 2.5), random.uniform(-4, 4));
    group.add(puff);
  }
  return group;
}

/** makePickupHalo: a flat ring facing up (the camera never goes below the
 *  water, so one winding is enough). */
function halo(color: number, radius: number): THREE.Mesh {
  const inner = radius * 0.82;
  const outer = radius * 1.08;
  const segments = 10;
  const tri: number[] = [];
  const at = (r: number, i: number) => {
    const a = (i / segments) * Math.PI * 2;
    tri.push(Math.cos(a) * r, 0, Math.sin(a) * r);
  };
  for (let i = 0; i < segments; i++) {
    // counter-clockwise seen from above
    at(inner, i), at(inner, i + 1), at(outer, i);
    at(outer, i), at(inner, i + 1), at(outer, i + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(tri), 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.34 }));
  mesh.position.y = -0.42;
  return mesh;
}

export type PickupType = "treasure" | "repair" | "ammo";

/** makePickupVisual: a chest with coins, a repair crate, or powder kegs, on a
 *  halo. The spinning part sits under a Joint; the halo stays level. */
export function pickupMesh(materials: Materials, type: PickupType): { mesh: THREE.Group; radius: number } {
  const group = new THREE.Group();
  const spin = new THREE.Joint("spin");
  group.add(spin);
  let radius = 2.2;
  if (type === "treasure") {
    const chest = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.05, 1.7), materials.hull);
    chest.position.y = 0.1;
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 2.8, 4, 1, false, 0, Math.PI), materials.hull);
    lid.rotation.z = Math.PI / 2;
    lid.position.y = 0.72;
    const frontBand = new THREE.Mesh(new THREE.BoxGeometry(2.95, 1.05, 0.12), materials.trim);
    frontBand.position.set(0, 0.18, -0.91);
    const sideBand = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.05, 1.86), materials.trim);
    sideBand.position.set(0.86, 0.18, 0);
    const sideBandMirror = sideBand.clone();
    sideBandMirror.position.x = -0.86;
    const lock = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.38, 0.12), materials.gold);
    lock.position.set(0, 0.25, -0.98);
    spin.add(chest, lid, frontBand, sideBand, sideBandMirror, lock);
    for (const [x, z] of [[-0.6, 0.2], [0.1, -0.25], [0.7, 0.15]]) {
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.06, 5), materials.gold);
      coin.rotation.z = Math.PI / 2;
      coin.position.set(x, 1.6, z);
      spin.add(coin);
    }
    group.add(halo(0xf7d65f, 2.4));
  } else if (type === "repair") {
    const box = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 2.2), materials.repair);
    const crossA = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.6, 0.08), materials.sail);
    const crossB = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.35, 0.08), materials.sail);
    crossA.position.z = -1.12;
    crossB.position.z = -1.13;
    const trimA = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.14, 0.12), materials.trim);
    trimA.position.set(0, 0.75, -1.14);
    const trimB = trimA.clone();
    trimB.position.y = -0.48;
    spin.add(box, crossA, crossB, trimA, trimB);
    group.add(halo(0xff6d5f, 2.25));
  } else {
    radius = 2.05;
    for (let i = 0; i < 3; i += 1) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 1.5, 6), materials.ammo);
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(0, 0.35 + i * 0.22, (i - 1) * 0.55);
      spin.add(barrel);
      for (const dx of [-0.42, 0.42]) {
        // the demo's torus hoops, as short open bands
        const hoop = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 6, 1, true), materials.trim);
        hoop.rotation.z = Math.PI / 2;
        hoop.position.set(dx, barrel.position.y, barrel.position.z);
        spin.add(hoop);
      }
    }
    group.add(halo(0x87e8f3, 2.05));
  }
  return { mesh: group, radius };
}

/** makeCannonballVisual: an iron ball in a faint glow. */
export function cannonball(materials: Materials, enemy: boolean): THREE.Group {
  const group = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.42, 6, 4), materials.cannonball);
  const glow = new THREE.Mesh(
    // the demo's 0.72 m glow at 0.18, larger and brighter so a shell reads at 400x240
    new THREE.IcosahedronGeometry(1.05, 0),
    new THREE.MeshBasicMaterial({ color: enemy ? 0xff785a : 0xffc15d, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending }),
  );
  group.add(ball, glow);
  return group;
}
