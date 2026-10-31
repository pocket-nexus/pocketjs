declare module "@pocketjs/framework/arcade" {
  export type Shape = "box" | "plane" | "sphere" | "cylinder" | "cone" | "torus" | number;
  export interface EntityOptions {
    shape?: Shape; // default "box"; every shape fits a 1x1x1 box at scale 1
    x?: number; y?: number; z?: number;
    rx?: number; ry?: number; rz?: number; // radians, applied Y then X then Z
    scale?: number; sx?: number; sy?: number; sz?: number;
    color?: number; // 0xRRGGBB
    emissive?: number; // 0 lit by the scene, 1 ignores lights
    alpha?: number;
    shadow?: boolean; // blob shadow on scene.ground
    visible?: boolean;
  }
  export class Entity {
    x: number; y: number; z: number; rx: number; ry: number; rz: number;
    sx: number; sy: number; sz: number; color: number; emissive: number; alpha: number;
    visible: boolean; shadow: boolean;
    set scale(v: number); set shape(v: Shape);
    at(x: number, y: number, z: number): this;
    touches(other: Entity, margin?: number): boolean; // sphere overlap
    overlaps(other: Entity): boolean; // axis-aligned box overlap
    remove(): void;
  }
  export function spawn(options?: EntityOptions): Entity; // at most 4096 alive
  export function destroy(entity: Entity): void;
  export function entities(): Entity[];
  export function defineMesh(vertices: number[], indices: number[]): number; // x,y,z,nx,ny,nz per vertex
  export const camera: {
    look(x: number, y: number, z: number, tx: number, ty: number, tz: number, fov?: number): void;
    follow(target: { x: number; y: number; z: number }, offset: [number, number, number], ease?: number, fov?: number): void;
  };
  export const scene: {
    sky(color: number): void;
    fog(color: number, near: number, far: number): void;
    sun(x: number, y: number, z: number, color?: number, strength?: number): void;
    ambient(top: number, bottom: number): void;
    ground(y: number): void;
  };
  // The screen is 1280x720. y is the top of the text line.
  export const hud: {
    rect(x: number, y: number, w: number, h: number, color?: number, alpha?: number): void;
    text(text: string | number, x: number, y: number, options?: { size?: number; color?: number; alpha?: number; align?: "left" | "center" | "right" }): void;
  };
  export const fx: { burst(x: number, y: number, z: number, options?: { color?: number; count?: number; speed?: number; life?: number; size?: number }): void };
  export const sfx: {
    tone(frequency: number, seconds?: number, options?: { volume?: number; wave?: "square" | "triangle" | "saw" | "noise" | "sine"; slide?: number }): void;
    coin(): void; jump(): void; hit(): void; lose(): void;
  };
  export type Button = "up" | "down" | "left" | "right" | "a" | "b" | "x" | "y" | "l" | "r" | "start" | "select";
  export const input: {
    x: number; y: number; // left stick and d-pad in [-1, 1]; +y is down
    rx: number; ry: number; // right stick
    lt: number; rt: number; // triggers in [0, 1]
    held(button: Button): boolean;
    pressed(button: Button): boolean;
    released(button: Button): boolean;
  };
  export const save: { load<T>(fallback: T): T; store(value: unknown): void };
  export const rand: {
    seed(value: number): void; float(): number; range(min: number, max: number): number;
    int(min: number, maxInclusive: number): number; pick<T>(items: readonly T[]): T;
  };
  export function clamp(v: number, min: number, max: number): number;
  export function lerp(a: number, b: number, t: number): number;
  export interface Game { setup?(): void; update(dt: number): void; draw?(): void }
  export function game(definition: Game): Game;
}
