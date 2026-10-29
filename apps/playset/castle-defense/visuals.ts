// Castle Defense's models and scenery, ported from GameBlocks' castle-defense
// (https://gb-castle-defense.vercel.app/src/main.js, MIT, xt4d/GameBlocks).
//
// The factories keep the demo's three.js calls; the import moved to the
// playset facade. The demo's orientToBasis maps an object's -Z forward and +Y
// up onto the playset's own axes, so local geometry is unchanged and only
// positions convert: demo (right, up, forward) is playset (x, y, -z).
//
// `scenery()` replays the demo's seeded generator call for call (clouds,
// road stones, trees, mountains, torches, banners), so every tree stands where
// the demo puts it; it returns them as descriptions the game culls against
// the fixed camera before placing.
//
// Deviations: segment counts are lowered for the PICA (trees 4/6/5 with open
// cones, towers 10, spheres 6x4 to 8x6); trees past 130 m from the fixed
// camera (more than half fogged) leave out their middle crown; the branches, the clouds and the sun
// disc (above the fixed camera's view) and the torch lights are not drawn,
// nor the trees outside the camera's view;
// the banner flags face the camera (the demo's double-sided planes); the road
// stones are their top faces; the sky dome is the playset sky gradient.

import * as THREE from "@pocketjs/framework/playset/three";
import { mulberry, type Random } from "../kit/random.ts";

export const COLORS = {
  stone: 0x9a9790,
  darkStone: 0x5b5a55,
  wood: 0x6d4426,
  brass: 0xd2a64b,
  grass: 0x5c8a4d,
  dirt: 0x9a7442,
  enemy: 0x8d322b,
  shield: 0x2f5578,
  monster: 0x527e48,
  roadEdge: 0xb58d57,
  banner: 0x18242d,
  gold: 0xf6c863,
  flame: 0xff9a35,
};

export const ENEMY_VISUAL_SCALE = 1.32;
export const PROJECTILE_VISUAL_SCALE = 1.45;

function material(color: number, roughness = 0.82, metalness = 0.03): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/** A mesh at demo (right, up, forward). */
function at(mesh: THREE.Object3D, right: number, up: number, forward: number): THREE.Object3D {
  mesh.position.set(right, up, -forward);
  return mesh;
}

/** The ground plane faces +Y. */
function flat(mesh: THREE.Mesh): THREE.Mesh {
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

export interface Tree {
  x: number;
  z: number;
  scale: number;
  /** the tree's model, built at the right place in the seeded sequence */
  model: THREE.Group;
}

export interface Scenery {
  ground: THREE.Group;
  castle: THREE.Group;
  trees: Tree[];
  mountains: THREE.Group;
  torches: THREE.Group;
  flames: { x: number; y: number; z: number }[];
  banners: { x: number; y: number; z: number }[];
}

/** How a tree is built: 0 not at all (the generator still advances), 1 near,
 *  2 far (in the fog: the middle crown left out). */
export type TreeDetail = 0 | 1 | 2;

/** The demo's createTree, at the origin (the game places it). */
function tree(prng: Random, scale: number, variant: number, detail: TreeDetail): THREE.Group {
  const group = new THREE.Group();
  group.rotation.y = prng.uniform(-0.35, 0.35);
  const trunkMat = material(prng.pick([0x5b351c, 0x69411f, 0x4d321d]), 0.78, 0.02);
  const leafPalette = variant === 0 ? [0x245a31, 0x2f6b3b, 0x3f7a3d] : variant === 1 ? [0x2e6538, 0x47763a, 0x5c7f3f] : [0x1e4f2f, 0x2e6235, 0x416f39];
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.26 * scale, 0.48 * scale, 3.7 * scale, 4, 1, true), trunkMat);
  trunk.position.y = 1.85 * scale;
  trunk.rotation.z = prng.uniform(-0.06, 0.06);
  group.add(trunk);
  for (let i = 0; i < 3; i += 1) {
    const crown = new THREE.Mesh(
      new THREE.ConeGeometry((2.45 - i * 0.34) * scale * prng.uniform(0.92, 1.08), (3.2 - i * 0.2) * scale, detail === 2 ? 5 : 6, 1, true),
      material(prng.pick(leafPalette), 0.9, 0.01),
    );
    crown.position.y = (3.45 + i * 1.25) * scale;
    crown.rotation.y = prng.uniform(-0.4, 0.4);
    if (detail === 1 || i !== 1) group.add(crown);
  }
  const top = new THREE.Mesh(new THREE.ConeGeometry(1.25 * scale, 2.1 * scale, 5, 1, true), material(prng.pick(leafPalette), 0.9, 0.01));
  top.position.y = 7.2 * scale;
  top.rotation.y = prng.uniform(-0.4, 0.4);
  group.add(top);
  // the two branches: their calls keep the sequence; they are not drawn
  for (let side = 0; side < 2; side += 1) {
    prng.uniform(-0.18, 0.18);
    prng.uniform(-0.18, 0.18);
  }
  return group;
}

/** Everything the demo's createWorld, createCastle and createBanner build, in
 *  its order of seeded calls; `detail` says how to build the tree at (x, z). */
export function scenery(detail: (x: number, z: number, scale: number) => TreeDetail, seed = 20260617): Scenery {
  const prng = mulberry(seed);
  // createSkyDome: the clouds draw from the generator first (not drawn here)
  for (let i = 0; i < 11; i += 1) {
    const puffs = 3 + (i % 3);
    for (let j = 0; j < puffs; j += 1) for (let k = 0; k < 7; k += 1) prng();
    prng();
    prng();
    prng();
    prng();
    prng();
  }

  // the grass: the demo's 260 x 150 plane, its far edge behind the last
  // band of trees (subdivided so the per-vertex fog follows the distance)
  const ground = new THREE.Group();
  ground.add(at(flat(new THREE.Mesh(new THREE.PlaneGeometry(260, 150, 8, 6), material(COLORS.grass))), 0, 0, 2));
  ground.add(at(flat(new THREE.Mesh(new THREE.PlaneGeometry(19.5, 102, 1, 8), material(COLORS.dirt))), 0, 0.03, 12));
  for (const side of [-1, 1]) {
    ground.add(at(flat(new THREE.Mesh(new THREE.PlaneGeometry(1.8, 102, 1, 8), material(COLORS.roadEdge, 0.9, 0.02))), side * 10.6, 0.045, 12));
  }
  for (let i = 0; i < 34; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    // a 0.1 m slab: its top face (the camera never sees its sides)
    const w = prng.uniform(0.8, 1.8);
    const stone = flat(new THREE.Mesh(new THREE.PlaneGeometry(w, prng.uniform(0.5, 1.2)), material(0xbba275, 0.88, 0.02)));
    const turn = new THREE.Group();
    turn.rotation.y = prng.uniform(-0.25, 0.25);
    stone.position.y = 0.05;
    turn.add(stone);
    ground.add(at(turn, side * prng.uniform(8.5, 12.5), 0.1, -32 + i * 2.9));
  }

  const trees: Tree[] = [];
  const createTree = (right: number, forward: number, scale = 1, variant = 0) => {
    const d = detail(right, -forward, scale);
    const model = tree(prng, scale, variant, d);
    if (d !== 0) trees.push({ x: right, z: -forward, scale, model });
  };
  for (let i = 0; i < 52; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const right = side * prng.uniform(24, 72);
    const forward = prng.uniform(-22, 54);
    createTree(right, forward, prng.uniform(0.88, 1.22), i % 3);
  }
  for (let i = 0; i < 44; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const bandOffset = row % 3 === 0 ? 0 : row % 3 === 1 ? 8 : -6;
    const right = side * prng.uniform(78 + bandOffset, 118);
    const forward = prng.uniform(-34, 60);
    createTree(right, forward, prng.uniform(0.82, 1.3), (i + 1) % 3);
  }
  const fieldTreeSpots: [number, number, number, number][] = [
    [-62, -18, 0.94, 0], [-80, -30, 1.1, 1], [-98, -16, 0.88, 2], [-112, 2, 1.18, 0],
    [-74, 8, 1.2, 2], [-92, 20, 0.98, 1], [-108, 36, 1.12, 0], [-84, 50, 0.86, 2],
    [-54, 32, 1.05, 1], [-118, 52, 1.24, 2], [-68, 58, 0.92, 0], [-104, -34, 1.02, 1],
    [62, -18, 0.94, 1], [80, -30, 1.1, 2], [98, -16, 0.88, 0], [112, 2, 1.18, 1],
    [74, 8, 1.2, 0], [92, 20, 0.98, 2], [108, 36, 1.12, 1], [84, 50, 0.86, 0],
    [54, 32, 1.05, 2], [118, 52, 1.24, 0], [68, 58, 0.92, 1], [104, -34, 1.02, 2],
  ];
  for (const [right, forward, scale, variant] of fieldTreeSpots) createTree(right, forward, scale, variant);
  const sideForestRows = [
    { forward: -48, count: 5, minRight: 46, maxRight: 122 },
    { forward: -30, count: 5, minRight: 54, maxRight: 118 },
    { forward: -10, count: 4, minRight: 58, maxRight: 108 },
    { forward: 14, count: 4, minRight: 62, maxRight: 112 },
    { forward: 38, count: 5, minRight: 52, maxRight: 120 },
  ];
  for (const side of [-1, 1]) {
    for (const row of sideForestRows) {
      for (let i = 0; i < row.count; i += 1) {
        const lane = row.count === 1 ? 0.5 : i / (row.count - 1);
        const baseRight = row.minRight + lane * (row.maxRight - row.minRight);
        const right = side * (baseRight + prng.uniform(-4, 4));
        const forward = row.forward + prng.uniform(-5, 5);
        createTree(right, forward, prng.uniform(0.76, 1.18), (i + row.count) % 3);
      }
    }
  }
  for (let i = 0; i < 56; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const stagger = row % 4;
    const right = side * prng.uniform(34 + stagger * 4, 126);
    const forward = prng.uniform(-70, -54) + stagger * 1.2;
    createTree(right, forward, prng.uniform(1.08, 1.78), (i + stagger) % 3);
  }

  const mountains = new THREE.Group();
  for (let i = 0; i < 13; i += 1) {
    const right = -84 + i * 15.5;
    const height = prng.uniform(15, 28);
    const mountain = new THREE.Mesh(new THREE.ConeGeometry(prng.uniform(9, 16), height, 4, 1, true), material(prng.pick([0x6e7874, 0x7a8179, 0x647371])));
    mountain.rotation.y = Math.PI / 4;
    mountains.add(at(mountain, right, height / 2 - 1, 68));
    const snow = new THREE.Mesh(new THREE.ConeGeometry(prng.uniform(2.2, 4.2), height * 0.18, 4), material(0xdce6df, 0.7, 0));
    snow.rotation.y = Math.PI / 4;
    mountains.add(at(snow, right, height - 1.3, 68));
  }

  const torches = new THREE.Group();
  const flames: Scenery["flames"] = [];
  for (const [right, forward] of [[-22, -28], [22, -28], [-7.5, -30], [7.5, -30]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 3.8, 5), material(0x4b2f1c, 0.74, 0.03));
    torches.add(at(pole, right, 1.9, forward));
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.38, 0.35, 8), material(0x2c2520, 0.48, 0.22));
    torches.add(at(bowl, right, 3.75, forward));
    flames.push({ x: right, y: 4.35, z: -forward });
    prng();
  }

  const castle = new THREE.Group();
  buildCastle(castle);
  const banners: Scenery["banners"] = [];
  for (const right of [-27, 27]) {
    banners.push({ x: right, y: 18.8, z: 29.2 });
    prng();
  }
  return { ground, castle, trees, mountains, torches, flames, banners };
}

/** The demo's createCastle and decorateGate. */
function buildCastle(castle: THREE.Group): void {
  const wallMat = material(COLORS.stone);
  const darkMat = material(COLORS.darkStone);
  castle.add(at(new THREE.Mesh(new THREE.BoxGeometry(48, 10, 4.4), wallMat), 0, 5, -34));
  castle.add(at(new THREE.Mesh(new THREE.BoxGeometry(9.5, 7.2, 4.9), material(0x5b351f)), 0, 3.6, -33.55));
  const metal = material(0x272829, 0.42, 0.28);
  for (const right of [-3.4, -1.7, 0, 1.7, 3.4]) castle.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.22, 6.4, 0.35), metal), right, 3.9, -30.9));
  for (const up of [2.4, 5.2]) castle.add(at(new THREE.Mesh(new THREE.BoxGeometry(8.7, 0.3, 0.4), metal), 0, up, -30.8));
  castle.add(at(new THREE.Mesh(new THREE.TorusGeometry(4.82, 0.18, 4, 12, Math.PI), metal), 0, 7.1, -30.82));
  for (const right of [-27, 27]) {
    castle.add(at(new THREE.Mesh(new THREE.CylinderGeometry(4.7, 5.2, 16, 10), wallMat), right, 8, -34));
    castle.add(at(new THREE.Mesh(new THREE.ConeGeometry(5.6, 5.5, 10, 1, true), material(0x7e2d25)), right, 18.7, -34));
  }
  for (let i = -5; i <= 5; i += 1) castle.add(at(new THREE.Mesh(new THREE.BoxGeometry(2.3, 2.1, 3), darkMat), i * 4.4, 11.2, -34));
  for (let row = 0; row < 5; row += 1) {
    for (let col = -6; col <= 6; col += 1) {
      if (Math.abs(col) <= 1 && row < 4) continue;
      const block = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.62, 0.2), material(row % 2 ? 0x817e78 : 0xa7a49c, 0.9, 0.01));
      castle.add(at(block, col * 3.55 + (row % 2 ? 1.45 : 0), 2.1 + row * 1.65, -31.64));
    }
  }
  for (const right of [-18, -10, 10, 18]) castle.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.48, 2.1, 0.26), material(0x242524, 0.7, 0.08)), right, 6.7, -31.5));
  castle.add(at(new THREE.Mesh(new THREE.BoxGeometry(19, 18, 18), wallMat), 0, 9, -48));
  const keepRoof = new THREE.Mesh(new THREE.ConeGeometry(14, 8, 4, 1, true), material(0x7e2d25));
  keepRoof.rotation.y = Math.PI / 4;
  castle.add(at(keepRoof, 0, 22, -48));
}

/** A torch flame (transparent, so an instance of its own). */
export function flame(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.ConeGeometry(0.36, 1.1, 6), new THREE.MeshBasicMaterial({ color: COLORS.flame, transparent: true, opacity: 0.9, depthWrite: false })));
  return group;
}

/** A banner on its pole; joint "flag" sways it. */
export function banner(color = COLORS.banner, scale = 1): THREE.Group {
  const group = new THREE.Group();
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * scale, 0.1 * scale, 4.6 * scale, 5), material(0x2b2723, 0.55, 0.2));
  pole.position.y = -0.2 * scale;
  group.add(pole);
  const joint = new THREE.Joint("flag");
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.6 * scale, 3.1 * scale, 1, 1), new THREE.MeshStandardMaterial({ color, roughness: 0.76, metalness: 0.02 }));
  flag.position.set(1.28 * scale, 0.42 * scale, 0);
  // the demo's flag is double-sided; this one turns its face to the camera
  flag.rotation.y = Math.PI;
  const trim = new THREE.Mesh(new THREE.PlaneGeometry(0.28 * scale, 3.14 * scale), new THREE.MeshStandardMaterial({ color: COLORS.gold, roughness: 0.48, metalness: 0.16 }));
  trim.position.set(0.1 * scale, 0.42 * scale, -0.01);
  trim.rotation.y = Math.PI;
  joint.add(flag, trim);
  group.add(joint);
  return group;
}

export type WeaponKey = "ballista" | "cannon" | "catapult" | "arrows";

/** A weapon mount (the demo's createWeaponModels and decorateWeaponMount). */
export function mount(key: WeaponKey): THREE.Group {
  const group = new THREE.Group();
  const platformMat = material(0x2d2621);
  const weaponMat = material(COLORS.brass, 0.55, 0.18);
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.9, 0.65, 8), platformMat));
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(key === "arrows" ? 1 : 3.8, 0.45, 0.45), weaponMat);
  barrel.position.set(0, 0.65, -0.4);
  barrel.rotation.y = key === "catapult" ? 0.2 : 0;
  group.add(barrel);
  const darkMetal = material(0x202322, 0.46, 0.32);
  const woodMat = material(COLORS.wood, 0.72, 0.02);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.11, 3, 10), darkMetal);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.34;
  group.add(ring);
  if (key === "ballista") {
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.38, 3.2), woodMat);
    stock.position.set(0, 0.96, -0.55);
    group.add(stock);
    for (const side of [-1, 1]) {
      const limb = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.22, 0.28), weaponMat);
      limb.position.set(side * 1.28, 1.08, -1.65);
      limb.rotation.y = side * 0.42;
      group.add(limb);
    }
  } else if (key === "cannon") {
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.43, 0.58, 2.9, 8), darkMetal);
    tube.rotation.x = Math.PI / 2;
    tube.position.set(0, 1.02, -1.0);
    group.add(tube);
    const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.58, 0.08, 4, 10), weaponMat);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 1.02, -2.48);
    group.add(muzzle);
  } else if (key === "catapult") {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 4.2), woodMat);
    arm.position.set(0, 1.36, -0.42);
    arm.rotation.x = -0.42;
    group.add(arm);
    const sling = new THREE.Mesh(new THREE.SphereGeometry(0.46, 8, 6), darkMetal);
    sling.position.set(0, 1.92, -2.25);
    group.add(sling);
  } else {
    for (let i = -2; i <= 2; i += 1) {
      const arrow = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.4, 4, 1, true), weaponMat);
      arrow.rotation.x = Math.PI / 2;
      arrow.position.set(i * 0.24, 1.18, -0.9 - Math.abs(i) * 0.06);
      group.add(arrow);
    }
    const crest = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.1, 8), material(0x93402f, 0.75, 0.03));
    crest.position.set(0, 1.65, 0.15);
    group.add(crest);
  }
  return group;
}

export type EnemyType = "soldier" | "shield" | "ram" | "tower" | "flyer" | "boss";

/** An attacker (createEnemyVisual, decorateEnemy, enlargeEnemyVisuals). The
 *  demo's lookAt turned each model's +Z to the castle, so its face looked
 *  back at the camera; the whole model turns half a circle here to keep that
 *  look while the playset's -Z leads the way. */
export function enemy(type: EnemyType, stat: { radius: number; flying?: boolean }): THREE.Group {
  const visual = new THREE.Group();
  const bodyMat = material(type === "flyer" ? 0x54335f : type === "boss" ? COLORS.monster : COLORS.enemy);
  visual.add(new THREE.Mesh(new THREE.BoxGeometry(stat.radius * 1.35, stat.flying ? 1 : 2.2, stat.radius * 1.1), bodyMat));
  if (type === "shield") {
    const shield = new THREE.Mesh(new THREE.BoxGeometry(stat.radius * 1.7, 1.7, 0.22), material(COLORS.shield));
    shield.position.set(0, 0.15, -0.65);
    visual.add(shield);
  }
  if (type === "ram" || type === "tower") {
    const cap = new THREE.Mesh(new THREE.BoxGeometry(stat.radius * 2.3, stat.radius * 1.3, stat.radius * 2.6), material(COLORS.wood));
    cap.position.y = type === "tower" ? 1.5 : 0;
    visual.add(cap);
  }
  if (type === "boss") {
    const head = new THREE.Mesh(new THREE.SphereGeometry(1.65, 8, 5), bodyMat);
    head.position.y = 2.6;
    visual.add(head);
  }
  if (type === "flyer") visual.add(new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.18, 0.8), bodyMat));
  const dark = material(0x2a2522, 0.64, 0.04);
  const metal = material(0x555553, 0.48, 0.18);
  const glow = new THREE.MeshBasicMaterial({ color: type === "boss" ? 0xffd05d : 0xffb05a });
  if (!["ram", "tower", "boss"].includes(type)) {
    const head = new THREE.Mesh(new THREE.SphereGeometry(stat.radius * 0.46, 6, 4), bodyMat);
    head.position.y = stat.flying ? 0.78 : 1.45;
    visual.add(head);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.08, 0.06), glow);
    eye.position.set(0, stat.flying ? 0.83 : 1.5, -stat.radius * 0.44);
    visual.add(eye);
  }
  if (type === "soldier" || type === "shield") {
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.65, 0.28), dark);
      leg.position.set(side * 0.32, -0.72, 0.04);
      visual.add(leg);
    }
    const spear = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 2.5, 4, 1, true), metal);
    spear.rotation.x = 0.28;
    spear.position.set(0.82, 0.38, -0.56);
    visual.add(spear);
  }
  if (type === "shield") {
    const boss = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 4), material(COLORS.gold, 0.48, 0.18));
    boss.position.set(0, 0.16, -0.79);
    visual.add(boss);
  }
  if (type === "ram" || type === "tower") {
    for (const side of [-1, 1]) {
      for (const z of [-1, 1]) {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.36, 6), dark);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * stat.radius * 0.82, -0.75, z * stat.radius * 0.72);
        visual.add(wheel);
      }
    }
    const ramHead = new THREE.Mesh(new THREE.ConeGeometry(0.52, 1.3, 6), metal);
    ramHead.rotation.x = -Math.PI / 2;
    ramHead.position.set(0, -0.1, -stat.radius * 1.55);
    visual.add(ramHead);
  }
  if (type === "tower") {
    for (let i = -1; i <= 1; i += 1) {
      const rung = new THREE.Mesh(new THREE.BoxGeometry(stat.radius * 1.8, 0.12, 0.16), metal);
      rung.position.set(0, 0.75 + i * 0.75, -stat.radius * 1.03);
      visual.add(rung);
    }
  }
  if (type === "flyer") {
    for (const side of [-1, 1]) {
      const wingTip = new THREE.Mesh(new THREE.ConeGeometry(0.38, 2.3, 6), bodyMat);
      wingTip.rotation.z = (side * Math.PI) / 2;
      wingTip.position.set(side * 2.8, 0, 0);
      visual.add(wingTip);
    }
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.32, 1.4, 6), dark);
    tail.rotation.x = Math.PI / 2;
    tail.position.set(0, -0.05, 0.95);
    visual.add(tail);
  }
  if (type === "boss") {
    for (const side of [-1, 1]) {
      const horn = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.55, 6), material(0xe0d1aa, 0.54, 0.04));
      horn.rotation.z = side * 0.52;
      horn.position.set(side * 0.85, 3.46, -0.12);
      visual.add(horn);
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 4), metal);
      shoulder.position.set(side * 2.35, 1.2, -0.08);
      visual.add(shoulder);
    }
    const eye = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.14, 0.08), glow);
    eye.position.set(0, 2.78, -1.25);
    visual.add(eye);
  }
  // enlargeEnemyVisuals
  visual.scale.setScalar(ENEMY_VISUAL_SCALE);
  if (!stat.flying) visual.position.y = (ENEMY_VISUAL_SCALE - 1) * stat.radius * 0.72;
  visual.rotation.y = Math.PI;
  const group = new THREE.Group();
  group.add(visual);
  return group;
}

/** A bolt (ballista, arrows) along -Z: the shaft and its additive glow. */
export function bolt(kind: "ballista" | "arrows"): THREE.Group {
  const color = kind === "arrows" ? 0xe8d7a6 : 0xffd38a;
  const s = PROJECTILE_VISUAL_SCALE;
  const group = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.09 * s, 2.7 * s, 4), material(color, 0.45, 0.05));
  shaft.rotation.x = Math.PI / 2;
  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16 * s, 0.04 * s, 3.6 * s, 6, 1, true),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.48, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  glow.rotation.x = Math.PI / 2;
  group.add(shaft, glow);
  return group;
}

/** A shell (cannon, catapult) with its glow; joint "spin" rolls it. */
export function shell(kind: "cannon" | "catapult"): THREE.Group {
  const s = PROJECTILE_VISUAL_SCALE;
  const spin = new THREE.Joint("spin");
  spin.add(new THREE.Mesh(new THREE.SphereGeometry((kind === "catapult" ? 0.72 : 0.44) * s, 8, 6), material(kind === "catapult" ? 0x34322f : 0x151515, 0.58, 0.08)));
  const glowColor = kind === "catapult" ? 0xff6b35 : 0xffb347;
  spin.add(
    new THREE.Mesh(
      new THREE.SphereGeometry((kind === "catapult" ? 1.05 : 0.72) * s, 8, 6),
      new THREE.MeshBasicMaterial({ color: glowColor, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }),
    ),
  );
  const group = new THREE.Group();
  group.add(spin);
  return group;
}

/** A trap on the approach (createTrapVisual). */
export function trap(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.5, 0.2, 12), material(0x3b3021, 0.8, 0.04)));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.12, 0.08, 4, 16), new THREE.MeshStandardMaterial({ color: COLORS.gold, roughness: 0.48, metalness: 0.18 }));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.14;
  group.add(ring);
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.85, 5), material(0x1e2020, 0.52, 0.26));
    spike.position.set(Math.cos(angle) * 1.45, 0.48, Math.sin(angle) * 1.45);
    spike.rotation.z = -Math.cos(angle) * 0.25;
    spike.rotation.x = Math.sin(angle) * 0.25;
    group.add(spike);
  }
  const rune = flat(
    new THREE.Mesh(new THREE.CircleGeometry(0.85, 12), new THREE.MeshBasicMaterial({ color: 0xffbd52, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false })),
  );
  rune.position.y = 0.16;
  group.add(rune);
  return group;
}

/** The aiming ring on the field (the port's cursor; the demo aimed with the mouse). */
export function reticle(): THREE.Group {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(2.2, 0.16, 4, 20),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.25;
  const dot = flat(new THREE.Mesh(new THREE.CircleGeometry(0.45, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending })));
  dot.position.y = 0.26;
  group.add(ring, dot);
  return group;
}
