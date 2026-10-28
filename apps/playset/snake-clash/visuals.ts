// Snake Clash's models, ported from GameBlocks' snake-clash demo
// (https://gb-snake-clash.vercel.app/, MIT, xt4d/GameBlocks): src/main.js
// createMaterials, createSegmentMesh, createAppleMesh, createBoardRim and
// BoardEnvironment's ground plane.
//
// The factories keep the demo's three.js calls; only the import moved to the
// playset facade. Deviations: the GridHelper's lines are thin flat strips
// (the PICA draws no lines here) in the colour the 65% grid lines blend to
// over the board; the ground plane is the playset ground (game.ts) so the
// segments' blob shadows land on it, standing in for the demo's shadow map;
// the grid and rims bake into static batches.

import * as THREE from "@pocketjs/framework/playset/three";

export const COLS = 16;
export const ROWS = 16;
export const CELL = 1;

export const PALETTE = {
  background: 0x1b242c,
  ground: 0x23303c,
  /** 0x507893 at 65% over the ground */
  grid: 0x405e74,
  rim: 0x364a5a,
  playerBody: 0xd72638,
  playerHead: 0xf04f5d,
  rivalBody: 0x2687c9,
  rivalHead: 0x6fd0ff,
  apple: 0x35b34a,
  leaf: 0x7ce084,
  stem: 0x6f431f,
};

/** The board's cell (0, 0) in the world: the board is centred on the origin. */
export const ORIGIN: readonly [number, number, number] = [-(COLS - 1) * CELL * 0.5, 0, (ROWS - 1) * CELL * 0.5];

function eyeMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0xfff5f6, emissive: 0x442222, roughness: 0.25 });
}

/** createSegmentMesh(isHead = false). */
export function segment(color: number): THREE.Group {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.62, 0.78), new THREE.MeshStandardMaterial({ color, roughness: 0.48, metalness: 0.08 })));
  return group;
}

/** createSegmentMesh(isHead = true): the eyes look along +Z, as the demo's. */
export function head(color: number): THREE.Group {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.68, 0.84), new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.08 }));
  const eyeGeometry = new THREE.SphereGeometry(0.055, 10, 10);
  const leftEye = new THREE.Mesh(eyeGeometry, eyeMaterial());
  const rightEye = new THREE.Mesh(eyeGeometry, eyeMaterial());
  leftEye.position.set(-0.17, 0.12, 0.33);
  rightEye.position.set(0.17, 0.12, 0.33);
  mesh.add(leftEye, rightEye);
  group.add(mesh);
  return group;
}

export function apple(): THREE.Group {
  const apple = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 18, 18),
    new THREE.MeshStandardMaterial({ color: PALETTE.apple, emissive: 0x0c3314, roughness: 0.55, metalness: 0.04 }),
  );
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.2, 10), new THREE.MeshStandardMaterial({ color: PALETTE.stem, roughness: 0.9 }));
  const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 12), new THREE.MeshStandardMaterial({ color: PALETTE.leaf, roughness: 0.7 }));
  stem.position.y = 0.28;
  stem.rotation.z = -0.28;
  leaf.position.set(0.12, 0.34, 0.02);
  leaf.scale.set(1.45, 0.55, 1);
  leaf.rotation.z = 0.6;
  apple.add(body, stem, leaf);
  return apple;
}

/** BoardEnvironment's ground plane: backgroundScale 1.08 at boardUp -0.7. */
export const GROUND = { y: -0.7, size: COLS * CELL * 1.08 };

/** The grid at gridUp -0.68 and the four rims; one static model centred on
 *  the origin. */
export function board(): THREE.Group {
  const group = new THREE.Group();
  const width = COLS * CELL;
  const depth = ROWS * CELL;
  const gridMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.grid, roughness: 0.92 });
  // one pixel wide at the camera's distance; the strips across the view are
  // seen at a grazing angle, so they are deeper by its elevation
  const line = 0.085;
  const across = 0.13;
  for (let i = 0; i <= COLS; i++) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(line, depth), gridMaterial);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(-width / 2 + i * CELL, -0.68, 0);
    group.add(strip);
  }
  for (let i = 0; i <= ROWS; i++) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(width, across), gridMaterial);
    strip.rotation.x = -Math.PI / 2;
    strip.position.set(0, -0.68, -depth / 2 + i * CELL);
    group.add(strip);
  }

  const borderMaterial = new THREE.MeshStandardMaterial({ color: PALETTE.rim, roughness: 0.88, metalness: 0.03 });
  const rimHeight = 0.6;
  const rimThickness = 0.45;
  // createBoardRim's placements, from the board's cell (0, 0) to the centre
  const cx = (COLS - 1) * CELL * 0.5;
  const cf = (ROWS - 1) * CELL * 0.5;
  const placements: [number, number, number, number, number, number][] = [
    [cx, -0.4, -0.65, width + rimThickness * 2, rimHeight, rimThickness],
    [cx, -0.4, depth - 0.35, width + rimThickness * 2, rimHeight, rimThickness],
    [-0.65, -0.4, cf, rimThickness, rimHeight, depth],
    [width - 0.35, -0.4, cf, rimThickness, rimHeight, depth],
  ];
  for (const [right, up, forward, w, h, d] of placements) {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), borderMaterial);
    rim.position.set(ORIGIN[0] + right, up, ORIGIN[2] - forward);
    group.add(rim);
  }
  return group;
}
