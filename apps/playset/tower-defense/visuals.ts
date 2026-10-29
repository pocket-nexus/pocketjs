// Tower Defense's models, ported from GameBlocks' tower-defense demo
// (https://gb-tower-defense.vercel.app/src/game.js, MIT, xt4d/GameBlocks):
// initScene, makeTile, addPathMarkers, createTower, spawnEnemy,
// makeProjectileVisual, HealthBarView and createRingEffect.
//
// The demo builds in a Z-up basis (right +x, up +z, forward +y) and turns
// each Y-up object into it; here the objects stay Y-up and forward is -Z.
// Deviations: the grass tiles' edge lines are a lighter rim around a raised
// top (the PICA draws no lines here); round parts have fewer segments (the
// creeps' capsules and the markers 8 around) for the vertex budget; the
// colours are the ones the demo shows, since its ACES tone mapping and 2.45
// hemisphere light wash its material colours out; the turret is a model of
// its own (game.ts gives it a slot that turns); the health bar is eight
// models, one per eighth of health, in the bar's three colours, tilted to
// face the fixed camera instead of billboarding; the selected tower's range
// ring and the effect rings are flat triangle rings; shadows are blobs.

import * as THREE from "@pocketjs/framework/playset/three";

export const TILE = 4;
export const COLS = 13;
export const ROWS = 9;
const HALF_RIGHT = (COLS - 1) * 0.5;
const HALF_FORWARD = (ROWS - 1) * 0.5;

const TURRET_HEIGHT_SCALE = 2;
export const ENEMY_HEIGHT_SCALE = 1.4;
const TOWER_BASE_HEIGHT = 0.55;
const TURRET_BODY_HEIGHT = 1.05;
const TURRET_BASE_Y = TOWER_BASE_HEIGHT * 0.5;
const TURRET_TOP_Y = TURRET_BASE_Y + TURRET_BODY_HEIGHT * TURRET_HEIGHT_SCALE;
export const TURRET_FIRE_HEIGHT = TURRET_TOP_Y + 0.08;
/** createTower: the group sits at cellCenter(cell, 0.18) */
export const TOWER_UP = 0.18;
/** buildWaypoints: cellCenter(cell, 0.55) */
export const PATH_UP = 0.55;

export const PATH_CELLS: readonly { right: number; forward: number }[] = [
  { right: 0, forward: 4 },
  { right: 2, forward: 4 },
  { right: 2, forward: 1 },
  { right: 5, forward: 1 },
  { right: 5, forward: 6 },
  { right: 8, forward: 6 },
  { right: 8, forward: 3 },
  { right: 12, forward: 3 },
];

export type TowerType = "cannon" | "laser" | "mortar" | "slow";
export const TOWER_ORDER: readonly TowerType[] = ["cannon", "laser", "mortar", "slow"];

export const TOWER_TYPES: Record<TowerType, { label: string; cost: number; range: number; damage: number; cooldown: number; projectileSpeed: number; color: number; projectileColor: number; splash: number; slow?: { factor: number; duration: number } }> = {
  cannon: { label: "Cannon", cost: 45, range: 10.5, damage: 26, cooldown: 0.82, projectileSpeed: 21, color: 0xd7ad55, projectileColor: 0xffd676, splash: 0 },
  laser: { label: "Laser", cost: 65, range: 9.2, damage: 10, cooldown: 0.22, projectileSpeed: 38, color: 0x62d6e8, projectileColor: 0x7af5ff, splash: 0 },
  mortar: { label: "Mortar", cost: 85, range: 13.5, damage: 34, cooldown: 1.35, projectileSpeed: 15, color: 0xea7a57, projectileColor: 0xff9d70, splash: 3.7 },
  slow: { label: "Slow", cost: 60, range: 8.5, damage: 4, cooldown: 0.55, projectileSpeed: 27, color: 0x9f8df6, projectileColor: 0xbba8ff, splash: 0, slow: { factor: 0.48, duration: 1.6 } },
};

export type EnemyType = "grunt" | "runner" | "brute" | "shield";
export const ENEMY_ORDER: readonly EnemyType[] = ["grunt", "runner", "brute", "shield"];
export const ENEMY_TYPES: Record<EnemyType, { hp: number; speed: number; reward: number; score: number; color: number; scale: number }> = {
  grunt: { hp: 70, speed: 2.4, reward: 11, score: 12, color: 0xf06a6a, scale: 1 },
  runner: { hp: 52, speed: 3.7, reward: 13, score: 16, color: 0xf5cb63, scale: 0.82 },
  brute: { hp: 145, speed: 1.72, reward: 21, score: 30, color: 0xb279ff, scale: 1.28 },
  shield: { hp: 105, speed: 2.15, reward: 17, score: 23, color: 0x74dbc4, scale: 1.08 },
};

/** The demo's materials as it renders them (0x8ccf65 base, 0x73bd67 grass
 *  with 0xb5e0a2 edges, 0xd9bb78 path, 0xff6d64 start, 0x63b8ff end). */
export const COLORS = {
  base: 0xcfe5aa,
  grass: 0xb4dc9a,
  grassEdge: 0xd8eec8,
  path: 0xeadeb6,
  start: 0xffb099,
  end: 0xb7ddee,
  marker: 0xf1c65a,
  markerStart: 0xe8524e,
  markerEnd: 0x2f94ec,
  towerBase: 0xe8f4f7,
  barrel: 0x496b7b,
};

/** cellCenter in the playset frame. */
export function cellX(right: number): number {
  return (right - HALF_RIGHT) * TILE;
}
export function cellZ(forward: number): number {
  return -(forward - HALF_FORWARD) * TILE;
}

/** expandPath: every cell the path crosses, corners included once. */
export function expandPath(corners: readonly { right: number; forward: number }[]): { right: number; forward: number }[] {
  const cells: { right: number; forward: number }[] = [];
  for (let i = 0; i < corners.length - 1; i++) {
    const from = corners[i];
    const to = corners[i + 1];
    const dr = Math.sign(to.right - from.right);
    const df = Math.sign(to.forward - from.forward);
    const steps = Math.max(Math.abs(to.right - from.right), Math.abs(to.forward - from.forward));
    for (let s = 0; s <= steps; s++) {
      const cell = { right: from.right + dr * s, forward: from.forward + df * s };
      const last = cells[cells.length - 1];
      if (!last || last.right !== cell.right || last.forward !== cell.forward) cells.push(cell);
    }
  }
  return cells;
}

/** The base, the tiles and the path markers: one static model. */
export function board(pathCells: readonly { right: number; forward: number }[]): THREE.Group {
  const group = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(COLS * TILE + 4, 0.5, ROWS * TILE + 4), new THREE.MeshStandardMaterial({ color: COLORS.base, roughness: 0.86 }));
  base.position.y = -0.32;
  group.add(base);
  const onPath = new Set(pathCells.map((c) => c.right + ":" + c.forward));
  const start = pathCells[0];
  const end = pathCells[pathCells.length - 1];
  const mat = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.02 });
  const grass = mat(COLORS.grass);
  const edge = mat(COLORS.grassEdge);
  const path = mat(COLORS.path);
  for (let f = 0; f < ROWS; f++) {
    for (let r = 0; r < COLS; r++) {
      const isPath = onPath.has(r + ":" + f);
      const x = cellX(r);
      const z = cellZ(f);
      if (isPath) {
        const color = r === start.right && f === start.forward ? mat(COLORS.start) : r === end.right && f === end.forward ? mat(COLORS.end) : path;
        const tile = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.94, 0.2, TILE * 0.94), color);
        tile.position.set(x, 0.01, z);
        group.add(tile);
      } else {
        // makeTile's EdgesGeometry outline: a light rim around a top 3 cm proud
        const tile = new THREE.Mesh(new THREE.BoxGeometry(TILE * 0.94, 0.16, TILE * 0.94), edge);
        tile.position.set(x, 0, z);
        const top = new THREE.Mesh(new THREE.PlaneGeometry(TILE * 0.94 - 0.2, TILE * 0.94 - 0.2), grass);
        top.rotation.x = -Math.PI / 2;
        top.position.set(x, 0.11, z);
        group.add(tile, top);
      }
    }
  }
  // addPathMarkers: a disc on every waypoint, red at the start, blue at the end
  const markerPath = new THREE.MeshStandardMaterial({ color: COLORS.marker, emissive: 0xffecaa, emissiveIntensity: 0.1, roughness: 0.58 });
  const markerStart = new THREE.MeshStandardMaterial({ color: COLORS.markerStart, emissive: 0xffbab0, emissiveIntensity: 0.12, roughness: 0.5 });
  const markerEnd = new THREE.MeshStandardMaterial({ color: COLORS.markerEnd, emissive: 0xaee6ff, emissiveIntensity: 0.12, roughness: 0.5 });
  pathCells.forEach((c, i) => {
    const marker = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.16, 8), i === 0 ? markerStart : i === pathCells.length - 1 ? markerEnd : markerPath);
    marker.position.set(cellX(c.right), PATH_UP + 0.18, cellZ(c.forward));
    group.add(marker);
  });
  return group;
}

/** createTower's hexagonal base, the same for every type. */
export function towerBase(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.CylinderGeometry(1.18, 1.36, TOWER_BASE_HEIGHT, 6), new THREE.MeshStandardMaterial({ color: COLORS.towerBase, roughness: 0.48 })));
  return group;
}

/** createTower's turret with its barrel along -Z, from the base's origin:
 *  a slot of its own that turns toward its target. */
export function turret(type: TowerType): THREE.Group {
  const def = TOWER_TYPES[type];
  const group = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = TURRET_BASE_Y + TURRET_BODY_HEIGHT * TURRET_HEIGHT_SCALE * 0.5;
  const turret = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.78, TURRET_BODY_HEIGHT * TURRET_HEIGHT_SCALE, 10),
    new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.45, metalness: 0.08 }),
  );
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.36, type === "mortar" ? 1.2 : 1.65), new THREE.MeshStandardMaterial({ color: COLORS.barrel, roughness: 0.35 }));
  barrel.position.set(0, 0.23 * TURRET_HEIGHT_SCALE, -0.82);
  body.add(turret, barrel);
  group.add(body);
  return group;
}

/** spawnEnemy's capsule and eye, facing -Z (its travel). */
export function enemy(type: EnemyType): THREE.Group {
  const def = ENEMY_TYPES[type];
  const s = def.scale;
  const group = new THREE.Group();
  const bodyRadius = 0.62 * s;
  const bodyLength = 0.9 * s;
  const half = bodyRadius + bodyLength * 0.5;
  const originalTop = 0.62 * s + half;
  const originalBottom = 0.62 * s - half;
  const bodyY = originalBottom + half * ENEMY_HEIGHT_SCALE;
  const top = bodyY + half * ENEMY_HEIGHT_SCALE;
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(bodyRadius, bodyLength, 2, 8), new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.5 }));
  body.scale.y = ENEMY_HEIGHT_SCALE;
  body.position.y = bodyY;
  group.add(body);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.13 * s, 6, 4), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.2 }));
  eye.position.set(0, top - (originalTop - 1.22 * s), -0.52 * s);
  group.add(eye);
  return group;
}

/** HealthBarView's upOffset above the enemy's origin. */
export function barHeight(type: EnemyType): number {
  const s = ENEMY_TYPES[type].scale;
  const half = 0.62 * s + 0.45 * s;
  const originalTop = 0.62 * s + half;
  const top = 0.62 * s - half + half * ENEMY_HEIGHT_SCALE * 2;
  return top + (2.15 * s - originalTop);
}

/** makeProjectileVisual: a capsule-ish cylinder along the flight, or a ball. */
export function projectile(type: TowerType): THREE.Group {
  const color = TOWER_TYPES[type].projectileColor;
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35 });
  if (type === "mortar") {
    group.add(new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 6), material));
  } else {
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.65, 6), material);
    shell.rotation.x = Math.PI / 2;
    group.add(shell);
  }
  return group;
}

/** HealthBarView at `eighths` of full health: the dark back and the fill in
 *  its colour (green above 60%, yellow above 30%, red below), tilted by
 *  `facing` to face the camera. */
export function healthBar(eighths: number, facing: number): THREE.Group {
  const ratio = eighths / 8;
  const color = ratio > 0.6 ? 0x7dff8a : ratio > 0.3 ? 0xffd86b : 0xff6767;
  const group = new THREE.Group();
  const plate = new THREE.Group();
  plate.rotation.x = -facing;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 0.28), new THREE.MeshBasicMaterial({ color: 0x101010, transparent: true, opacity: 0.92 }));
  const width = 1.5 * ratio;
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.14), new THREE.MeshBasicMaterial({ color }));
  fill.position.set(-0.75 + width * 0.5, 0, 0.01);
  plate.add(back, fill);
  // the bar's seven segment marks
  for (let i = 1; i < 8; i++) {
    const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.24), new THREE.MeshBasicMaterial({ color: 0x0f1012 }));
    mark.position.set(-0.75 + (1.5 * i) / 8, 0, 0.02);
    plate.add(mark);
  }
  group.add(plate);
  return group;
}

/** A flat ring of triangles in the ground plane, `segments` around. */
export function flatRing(inner: number, outer: number, segments: number): THREE.BufferGeometry {
  const positions = new Float32Array(segments * 18);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p = [
      [Math.cos(a0) * inner, Math.sin(a0) * inner],
      [Math.cos(a0) * outer, Math.sin(a0) * outer],
      [Math.cos(a1) * outer, Math.sin(a1) * outer],
      [Math.cos(a1) * inner, Math.sin(a1) * inner],
    ];
    // counter-clockwise seen from above (+Y), with (x, -z) as the plane
    const quad = [p[0], p[1], p[2], p[0], p[2], p[3]];
    for (let k = 0; k < 6; k++) {
      positions[i * 18 + k * 3] = quad[k][0];
      positions[i * 18 + k * 3 + 1] = 0;
      positions[i * 18 + k * 3 + 2] = -quad[k][1];
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return g;
}

/** createRingEffect at unit radius: scaled and faded by the game. */
export function effectRing(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(flatRing(0.4, 0.45, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.62, blending: THREE.AdditiveBlending })));
  return group;
}

/** The selected tower type's range, shown at the cursor. */
export function rangeRing(type: TowerType): THREE.Group {
  const def = TOWER_TYPES[type];
  const group = new THREE.Group();
  group.add(new THREE.Mesh(flatRing(def.range - 0.12, def.range + 0.12, 64), new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.55 })));
  return group;
}

/** The build cursor: a square frame around one tile. */
export function cursor(color: number): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color });
  const size = TILE * 0.98;
  const bar = 0.2;
  for (const [x, z, w, d] of [
    [0, -size / 2, size, bar],
    [0, size / 2, size, bar],
    [-size / 2, 0, bar, size],
    [size / 2, 0, bar, size],
  ]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(w, 0.12, d), material);
    side.position.set(x, 0, z);
    group.add(side);
  }
  return group;
}
