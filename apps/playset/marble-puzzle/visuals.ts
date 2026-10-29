// Marble Puzzle's models, ported from GameBlocks' marble-puzzle demo
// (https://gb-marble-puzzle.vercel.app/src/main.js, MIT, xt4d/GameBlocks):
// buildLevel, makeBox, makeCylinder, addWallCap, addHoleRim,
// addMovingBlockAccents and createStarVisual.
//
// The demo builds in a Z-up basis (right +x, up +z, forward +y); these build
// the same meshes in the playset's Y-up frame, plate-local: (right, up,
// forward) is (x, y, -z). Deviations: the canvas textures are gone, so the
// plate and wall colours are the colours the demo shows (its texture times
// its material colour, through its metalness and tone mapping), and the
// plate's 64-pixel grid lines are thin strips in the texture's 16% dark
// line colour over it; the halos' tubes are thicker and coarser (4 around)
// so they survive the 400x240 screen and the vertex budget, and the rims'
// 6 around; shadows are dropped.

import * as THREE from "@pocketjs/framework/playset/three";
import type { TiltPlate } from "@pocketjs/framework/playset/tilt";

/** A level as game.js writes it: a tilt plate whose pickups are its stars. */
export interface MarbleLevel extends Omit<TiltPlate, "pickups"> {
  stars: TiltPlate["pickups"];
}

export const MARBLE_RADIUS = 0.42;
export const STAR_UP = 0.72;
export const BLOCK_UP = 0.36;

export const PALETTE = {
  /** '#6fa19c' board texture times 0x5d8584, as the demo shows it */
  platform: 0x1c5e62,
  /** the texture's rgba(7, 20, 24, 0.16) lines over the platform */
  platformLine: 0x184f52,
  /** '#94b5b2' wall texture times 0x8fafb0 */
  wall: 0x44706b,
  /** 0xf0d48a at metalness 0.58 */
  wallCap: 0xb3a066,
  moving: 0x4f73ff,
  movingAccent: 0x9cc8ff,
  hole: 0x060809,
  holeRim: 0x2a3338,
  goal: 0x39e79b,
  star: 0xffd56a,
  starHalo: 0xffedaa,
  marble: 0xf9fbff,
};

const materials = () => ({
  platform: new THREE.MeshStandardMaterial({ color: PALETTE.platform, roughness: 0.52, metalness: 0.2 }),
  line: new THREE.MeshStandardMaterial({ color: PALETTE.platformLine, roughness: 0.52 }),
  wall: new THREE.MeshStandardMaterial({ color: PALETTE.wall, roughness: 0.43, metalness: 0.24 }),
  wallCap: new THREE.MeshStandardMaterial({ color: PALETTE.wallCap, roughness: 0.28, metalness: 0.58 }),
  hole: new THREE.MeshStandardMaterial({ color: PALETTE.hole, roughness: 0.82, metalness: 0.18 }),
  holeRim: new THREE.MeshStandardMaterial({ color: PALETTE.holeRim, roughness: 0.32, metalness: 0.72, emissive: 0x031314, emissiveIntensity: 0.45 }),
  goal: new THREE.MeshStandardMaterial({ color: PALETTE.goal, roughness: 0.25, metalness: 0.25, emissive: 0x0f6a3c, emissiveIntensity: 0.6 }),
});

function box(width: number, height: number, depth: number, material: THREE.Material, right: number, up: number, forward: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.set(right, up, -forward);
  return mesh;
}

/** A torus lying flat on the plate (the demo's planeBasisQuaternion). */
function flatRing(radius: number, tube: number, material: THREE.Material, right: number, up: number, forward: number): THREE.Mesh {
  const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 6, 64), material);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(right, up, -forward);
  return ring;
}

/** The plate with its walls, caps, holes, rims, goal and grid: one model,
 *  drawn as one dynamic node the module tilts. */
export function level(lv: MarbleLevel): THREE.Group {
  const m = materials();
  const group = new THREE.Group();
  group.add(box(lv.size.right, 0.34, lv.size.forward, m.platform, 0, -0.17, 0));
  // the board texture's grid: a line every 64 of 512 pixels, from 32, with
  // the texture repeated 1.3 times across the plate
  const lines: number[] = [];
  for (let rep = 0; rep < 2; rep++) for (let k = 0; k < 8; k++) {
    const u = (0.0625 + 0.125 * k + rep) / 1.3;
    if (u < 1) lines.push(u);
  }
  const width = 0.07;
  for (const u of lines) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(width, lv.size.forward), m.line);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(-lv.size.right / 2 + u * lv.size.right, 0.004, 0);
    group.add(strip);
    const across = new THREE.Mesh(new THREE.PlaneGeometry(lv.size.right, width), m.line);
    across.rotation.x = -Math.PI / 2;
    across.position.set(0, 0.004, -(-lv.size.forward / 2 + u * lv.size.forward));
    group.add(across);
  }
  for (const wall of lv.walls) {
    group.add(box(wall.width, 0.95, wall.depth, m.wall, wall.right, 0.48, wall.forward));
    group.add(box(Math.max(0.12, wall.width - 0.08), 0.055, Math.max(0.12, wall.depth - 0.08), m.wallCap, wall.right, 0.98, wall.forward));
  }
  for (const hole of lv.holes) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(hole.radius, hole.radius, 0.035, 64), m.hole);
    disc.position.set(hole.right, 0.018, -hole.forward);
    group.add(disc);
    group.add(flatRing(hole.radius * 1.02, 0.045, m.holeRim, hole.right, 0.075, hole.forward));
  }
  const goalBase = new THREE.Mesh(new THREE.CylinderGeometry(lv.goal.radius, lv.goal.radius, 0.08, 64), m.goal);
  goalBase.position.set(lv.goal.right, 0.05, -lv.goal.forward);
  group.add(goalBase);
  group.add(flatRing(lv.goal.radius, 0.065, m.goal, lv.goal.right, 0.18, lv.goal.forward));
  return group;
}

/** A moving block with its accent panel; the node's origin is the block's
 *  centre (BLOCK_UP above the plate). */
export function movingBlock(width: number, depth: number): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.72, depth),
    new THREE.MeshStandardMaterial({ color: PALETTE.moving, roughness: 0.3, metalness: 0.2, emissive: 0x122a7a, emissiveIntensity: 0.42 }),
  ));
  const top = new THREE.Mesh(
    new THREE.BoxGeometry(width * 0.72, 0.04, depth * 0.72),
    new THREE.MeshBasicMaterial({ color: PALETTE.movingAccent, transparent: true, opacity: 0.78 }),
  );
  top.position.y = 0.385;
  group.add(top);
  return group;
}

/** createStarVisual, spun by two joints: the demo turns it about up at
 *  2.3 rad/s and about its right axis at 1.1 rad/s. */
export function star(): THREE.Group {
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.34, 0),
    new THREE.MeshStandardMaterial({ color: PALETTE.star, roughness: 0.2, metalness: 0.42, emissive: 0x7c4b00, emissiveIntensity: 0.55 }),
  );
  const haloMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.starHalo, transparent: true, opacity: 0.58, depthWrite: false });
  const halo = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.03, 4, 48), haloMaterial);
  halo.rotation.x = -Math.PI / 2;
  // the vertical halo's basis (forward, up, right): its ring stands in the
  // plane of up and right
  const vertical = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.026, 4, 42), haloMaterial);
  vertical.rotation.y = Math.PI / 2;
  const tumble = new THREE.Joint("tumble");
  tumble.add(core, halo, vertical);
  const spin = new THREE.Joint("spin");
  spin.add(tumble);
  const group = new THREE.Group();
  group.add(spin);
  return group;
}

export function marble(): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(
    new THREE.SphereGeometry(MARBLE_RADIUS, 48, 32),
    new THREE.MeshPhysicalMaterial({ color: PALETTE.marble, roughness: 0.13, metalness: 0.02 }),
  ));
  return group;
}
