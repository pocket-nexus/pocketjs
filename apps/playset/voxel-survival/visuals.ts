// Voxel Survival's palette and the one model it draws besides the blocks,
// ported from GameBlocks' voxel-survival demo
// (https://gb-voxel-survival.vercel.app/, MIT, xt4d/GameBlocks).
//
// The demo draws chunk meshes with vertex colours (its BLOCKS table and face
// shades) and a CSS crosshair. Here the voxel module meshes the chunks with
// the same colours and shades; the block border lines (LineSegments) are not
// drawn, and corner occlusion baked into the colours stands in for them and
// for the shadow map. The crosshair is a small unlit cross held in front of
// the eye.

import * as THREE from "@pocketjs/framework/playset/three";

export const BLOCK = { air: 0, dirt: 1, stone: 2, wood: 3, crystal: 4, leaf: 5 } as const;

/** The demo's BLOCKS table: name and colour per type. */
export const BLOCKS: readonly { name: string; color: number }[] = [
  { name: "Air", color: 0x000000 },
  { name: "Dirt", color: 0x9a6a3a },
  { name: "Stone", color: 0x8f9290 },
  { name: "Wood", color: 0x5b341d },
  { name: "Crystal", color: 0x69d7ff },
  { name: "Leaves", color: 0x3f8f3c },
];

/** The sky by time of day: night, day and dusk (main.js updateDayNight). */
export const SKY = { day: 0x82c8ff, dusk: 0xe0835c, night: 0x050816 };

/** A white cross 0.3 m in front of the eye: about 12 pixels on the top screen. */
export function crosshair(): THREE.Group {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  group.add(
    new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.0026, 0.0004), mat),
    new THREE.Mesh(new THREE.BoxGeometry(0.0026, 0.018, 0.0004), mat),
  );
  return group;
}
