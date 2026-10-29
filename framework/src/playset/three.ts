// Content in the shape of three.js: Object3D trees of meshes built from
// primitive geometries and colour materials, flattened once into a playset
// model description.
//
// The tree is a LOAD-TIME object model. `Playset.model(root)` reads it,
// returns a native model id, and the tree is garbage afterwards: nothing
// here runs per frame, and moving an instance is the kernel's job (or
// `Playset.move` for a scenery node). Parameter order and defaults follow
// three.js r161, so a GameBlocks visual factory ports by changing its import.
//
// What maps and what does not:
//   - geometries: Box, Sphere, Cylinder, Cone, Capsule, Torus, Plane, Circle,
//     Ring, Icosahedron, Octahedron, Dodecahedron, Tetrahedron, and
//     BufferGeometry with a position attribute; rotateX/Y/Z, translate and
//     scale on a geometry apply before the mesh's transform;
//   - materials: every Mesh*Material is a colour, an emissive amount, an
//     opacity and a blend mode; maps, metalness and roughness are dropped;
//   - an Object3D with `joint = true` (or a `Joint`) is a joint: its subtree
//     moves with it, and archetype joint drivers spin, steer or aim it.
//   - segment counts above the device caps (Playset.lod) are reduced natively.

import {
  PLAYSET_BLEND,
  PLAYSET_GEOM,
  PLAYSET_MODEL,
  PLAYSET_PART,
} from "../../../contracts/spec/playset.ts";

export const MathUtils = {
  DEG2RAD: Math.PI / 180,
  RAD2DEG: 180 / Math.PI,
  clamp: (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v),
  lerp: (a: number, b: number, t: number) => a + (b - a) * t,
  degToRad: (d: number) => (d * Math.PI) / 180,
  radToDeg: (r: number) => (r * 180) / Math.PI,
  randFloat: (lo: number, hi: number) => lo + Math.random() * (hi - lo),
};

export class Vector3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  setScalar(s: number): this {
    return this.set(s, s, s);
  }
  copy(v: Vector3): this {
    return this.set(v.x, v.y, v.z);
  }
  clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }
  add(v: Vector3): this {
    return this.set(this.x + v.x, this.y + v.y, this.z + v.z);
  }
  sub(v: Vector3): this {
    return this.set(this.x - v.x, this.y - v.y, this.z - v.z);
  }
  multiplyScalar(s: number): this {
    return this.set(this.x * s, this.y * s, this.z * s);
  }
  length(): number {
    return Math.hypot(this.x, this.y, this.z);
  }
  normalize(): this {
    const l = this.length() || 1;
    return this.multiplyScalar(1 / l);
  }
}

export class Euler {
  constructor(public x = 0, public y = 0, public z = 0, public order: "XYZ" | "YXZ" | "ZXY" | "ZYX" | "YZX" | "XZY" = "XYZ") {}
  set(x: number, y: number, z: number, order?: Euler["order"]): this {
    this.x = x;
    this.y = y;
    this.z = z;
    if (order) this.order = order;
    return this;
  }
  copy(e: Euler): this {
    return this.set(e.x, e.y, e.z, e.order);
  }
}

export class Color {
  r = 1;
  g = 1;
  b = 1;
  constructor(value?: number | string | Color, g?: number, b?: number) {
    if (value !== undefined) this.set(value, g, b);
  }
  set(value: number | string | Color, g?: number, b?: number): this {
    if (value instanceof Color) {
      this.r = value.r;
      this.g = value.g;
      this.b = value.b;
    } else if (typeof value === "number" && g !== undefined && b !== undefined) {
      this.r = value;
      this.g = g;
      this.b = b;
    } else if (typeof value === "number") {
      this.setHex(value);
    } else if (value.startsWith("#")) {
      this.setHex(parseInt(value.slice(1), 16));
    }
    return this;
  }
  setHex(hex: number): this {
    this.r = ((hex >> 16) & 255) / 255;
    this.g = ((hex >> 8) & 255) / 255;
    this.b = (hex & 255) / 255;
    return this;
  }
  setRGB(r: number, g: number, b: number): this {
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }
  setHSL(h: number, s: number, l: number): this {
    const hue = (p: number, q: number, t: number) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * 6 * (2 / 3 - t);
      return p;
    };
    if (s === 0) return this.setRGB(l, l, l);
    const q = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return this.setRGB(hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3));
  }
  lerp(c: Color, t: number): this {
    this.r += (c.r - this.r) * t;
    this.g += (c.g - this.g) * t;
    this.b += (c.b - this.b) * t;
    return this;
  }
  multiplyScalar(s: number): this {
    this.r *= s;
    this.g *= s;
    this.b *= s;
    return this;
  }
  clone(): Color {
    return new Color(this);
  }
  getHex(): number {
    const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
    return (q(this.r) << 16) | (q(this.g) << 8) | q(this.b);
  }
}

/** Row-major 3x4 affine matrix (the native layout). */
export type Affine = [number, number, number, number, number, number, number, number, number, number, number, number];

export function identity(): Affine {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
}

export function multiply(a: Affine, b: Affine): Affine {
  const r = identity();
  for (let row = 0; row < 3; row++) {
    const a0 = a[row * 4], a1 = a[row * 4 + 1], a2 = a[row * 4 + 2], a3 = a[row * 4 + 3];
    r[row * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
    r[row * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    r[row * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    r[row * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
  }
  return r;
}

function rotationX(a: number): Affine {
  const s = Math.sin(a), c = Math.cos(a);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
}
function rotationY(a: number): Affine {
  const s = Math.sin(a), c = Math.cos(a);
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
}
function rotationZ(a: number): Affine {
  const s = Math.sin(a), c = Math.cos(a);
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}

/** T * R * S, with R in the Euler's order (three.js: "XYZ" = Rx * Ry * Rz). */
export function compose(p: Vector3, e: Euler, s: Vector3): Affine {
  const axes: Record<string, (a: number) => Affine> = { X: rotationX, Y: rotationY, Z: rotationZ };
  const angle: Record<string, number> = { X: e.x, Y: e.y, Z: e.z };
  let r = identity();
  for (const axis of e.order) r = multiply(r, axes[axis](angle[axis]));
  const m = multiply(r, [s.x, 0, 0, 0, 0, s.y, 0, 0, 0, 0, s.z, 0]);
  m[3] = p.x;
  m[7] = p.y;
  m[11] = p.z;
  return m;
}

export function transformPoint(m: Affine, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z + m[3],
    m[4] * x + m[5] * y + m[6] * z + m[7],
    m[8] * x + m[9] * y + m[10] * z + m[11],
  ];
}

// --- geometries -------------------------------------------------------------

export class BufferGeometry {
  /** PLAYSET_GEOM id and three.js constructor parameters */
  readonly kind: number = PLAYSET_GEOM.RAW;
  params: number[] = [];
  /** applied before the mesh's own transform */
  matrix: Affine = identity();
  positions: Float32Array | null = null;
  index: number[] | null = null;
  parameters: Record<string, number> = {};

  setAttribute(name: string, attribute: Float32BufferAttribute): this {
    if (name === "position") this.positions = attribute.array;
    return this;
  }
  setIndex(index: number[]): this {
    this.index = index;
    return this;
  }
  getAttribute(name: string): Float32BufferAttribute | undefined {
    return name === "position" && this.positions ? new Float32BufferAttribute(this.positions, 3) : undefined;
  }
  applyMatrix(m: Affine): this {
    this.matrix = multiply(m, this.matrix);
    return this;
  }
  rotateX(a: number): this {
    return this.applyMatrix(rotationX(a));
  }
  rotateY(a: number): this {
    return this.applyMatrix(rotationY(a));
  }
  rotateZ(a: number): this {
    return this.applyMatrix(rotationZ(a));
  }
  translate(x: number, y: number, z: number): this {
    return this.applyMatrix([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z]);
  }
  scale(x: number, y: number, z: number): this {
    return this.applyMatrix([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0]);
  }
  center(): this {
    return this;
  }
  computeVertexNormals(): void {}
  dispose(): void {}
  clone(): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(c, this);
    c.params = this.params.slice();
    c.matrix = this.matrix.slice() as Affine;
    return c;
  }
}

export class Float32BufferAttribute {
  constructor(public array: Float32Array, public itemSize: number) {
    if (!(array instanceof Float32Array)) this.array = new Float32Array(array as unknown as number[]);
  }
  get count(): number {
    return this.array.length / this.itemSize;
  }
}

class Primitive extends BufferGeometry {
  constructor(readonly kind: number, params: number[], parameters: Record<string, number> = {}) {
    super();
    this.params = params;
    this.parameters = parameters;
  }
}

export class BoxGeometry extends Primitive {
  constructor(width = 1, height = 1, depth = 1) {
    super(PLAYSET_GEOM.BOX, [width, height, depth], { width, height, depth });
  }
}
export class SphereGeometry extends Primitive {
  constructor(radius = 1, widthSegments = 32, heightSegments = 16, phiStart = 0, phiLength = Math.PI * 2, thetaStart = 0, thetaLength = Math.PI) {
    super(PLAYSET_GEOM.SPHERE, [radius, widthSegments, heightSegments, phiStart, phiLength, thetaStart, thetaLength], { radius });
  }
}
export class CylinderGeometry extends Primitive {
  constructor(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = Math.PI * 2) {
    super(PLAYSET_GEOM.CYLINDER, [radiusTop, radiusBottom, height, radialSegments, heightSegments, openEnded ? 1 : 0, thetaStart, thetaLength], { radiusTop, radiusBottom, height });
  }
}
export class ConeGeometry extends Primitive {
  constructor(radius = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = Math.PI * 2) {
    super(PLAYSET_GEOM.CYLINDER, [0, radius, height, radialSegments, heightSegments, openEnded ? 1 : 0, thetaStart, thetaLength], { radius, height });
  }
}
export class CapsuleGeometry extends Primitive {
  constructor(radius = 1, length = 1, capSegments = 4, radialSegments = 8) {
    super(PLAYSET_GEOM.CAPSULE, [radius, length, capSegments, radialSegments], { radius, length });
  }
}
export class TorusGeometry extends Primitive {
  constructor(radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48, arc = Math.PI * 2) {
    super(PLAYSET_GEOM.TORUS, [radius, tube, radialSegments, tubularSegments, arc], { radius, tube });
  }
}
export class PlaneGeometry extends Primitive {
  constructor(width = 1, height = 1, widthSegments = 1, heightSegments = 1) {
    super(PLAYSET_GEOM.PLANE, [width, height, widthSegments, heightSegments], { width, height });
  }
}
export class CircleGeometry extends Primitive {
  constructor(radius = 1, segments = 32, thetaStart = 0, thetaLength = Math.PI * 2) {
    super(PLAYSET_GEOM.CIRCLE, [radius, segments, thetaStart, thetaLength], { radius });
  }
}
export class RingGeometry extends Primitive {
  constructor(innerRadius = 0.5, outerRadius = 1, thetaSegments = 32, _phiSegments = 1, thetaStart = 0, thetaLength = Math.PI * 2) {
    super(PLAYSET_GEOM.RING, [innerRadius, outerRadius, thetaSegments, thetaStart, thetaLength], { innerRadius, outerRadius });
  }
}
export class IcosahedronGeometry extends Primitive {
  constructor(radius = 1, detail = 0) {
    super(PLAYSET_GEOM.ICOSAHEDRON, [radius, detail], { radius });
  }
}
export class OctahedronGeometry extends Primitive {
  constructor(radius = 1, detail = 0) {
    super(PLAYSET_GEOM.OCTAHEDRON, [radius, detail], { radius });
  }
}
export class DodecahedronGeometry extends Primitive {
  constructor(radius = 1, detail = 0) {
    super(PLAYSET_GEOM.DODECAHEDRON, [radius, detail], { radius });
  }
}
export class TetrahedronGeometry extends Primitive {
  constructor(radius = 1, detail = 0) {
    super(PLAYSET_GEOM.TETRAHEDRON, [radius, detail], { radius });
  }
}

// --- materials ----------------------------------------------------------------

export const NormalBlending = 1;
export const AdditiveBlending = 2;
export const FrontSide = 0;
export const BackSide = 1;
export const DoubleSide = 2;

export interface MaterialParameters {
  color?: number | string | Color;
  emissive?: number | string | Color;
  emissiveIntensity?: number;
  opacity?: number;
  transparent?: boolean;
  blending?: number;
  flatShading?: boolean;
  wireframe?: boolean;
  side?: number;
  depthWrite?: boolean;
  [key: string]: unknown;
}

export class Material {
  color = new Color(0xffffff);
  emissive = new Color(0x000000);
  emissiveIntensity = 1;
  opacity = 1;
  transparent = false;
  blending = NormalBlending;
  flatShading = false;
  wireframe = false;
  /** MeshBasicMaterial: no lighting */
  unlit = false;
  constructor(p: MaterialParameters = {}) {
    if (p.color !== undefined) this.color.set(p.color);
    if (p.emissive !== undefined) this.emissive.set(p.emissive);
    if (p.emissiveIntensity !== undefined) this.emissiveIntensity = p.emissiveIntensity;
    if (p.opacity !== undefined) this.opacity = p.opacity;
    if (p.transparent !== undefined) this.transparent = p.transparent;
    if (p.blending !== undefined) this.blending = p.blending;
    if (p.flatShading !== undefined) this.flatShading = p.flatShading;
    if (p.wireframe !== undefined) this.wireframe = p.wireframe;
  }
  clone(): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(c, this);
    c.color = this.color.clone();
    c.emissive = this.emissive.clone();
    return c;
  }
  dispose(): void {}
  /** 0 lit .. 1 unlit: the emissive colour's weight against the base colour. */
  emissiveAmount(): number {
    if (this.unlit) return 1;
    const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const e = lum(this.emissive) * this.emissiveIntensity;
    if (e <= 0) return 0;
    return Math.min(1, e / Math.max(lum(this.color), 0.05));
  }
}

export class MeshStandardMaterial extends Material {}
export class MeshLambertMaterial extends Material {}
export class MeshPhongMaterial extends Material {}
export class MeshToonMaterial extends Material {}
export class MeshPhysicalMaterial extends Material {}
export class MeshBasicMaterial extends Material {
  constructor(p: MaterialParameters = {}) {
    super(p);
    this.unlit = true;
  }
}

// --- objects ----------------------------------------------------------------

let nextId = 1;

export class Object3D {
  readonly id = nextId++;
  name = "";
  position = new Vector3();
  rotation = new Euler();
  scale = new Vector3(1, 1, 1);
  children: Object3D[] = [];
  parent: Object3D | null = null;
  visible = true;
  /** a joint: its subtree moves with joint drivers */
  joint = false;
  userData: Record<string, unknown> = {};
  castShadow = false;
  receiveShadow = false;
  renderOrder = 0;

  add(...objects: Object3D[]): this {
    for (const o of objects) {
      if (o.parent) o.parent.remove(o);
      o.parent = this;
      this.children.push(o);
    }
    return this;
  }
  remove(...objects: Object3D[]): this {
    for (const o of objects) {
      const i = this.children.indexOf(o);
      if (i >= 0) {
        this.children.splice(i, 1);
        o.parent = null;
      }
    }
    return this;
  }
  traverse(fn: (o: Object3D) => void): void {
    fn(this);
    for (const c of this.children) c.traverse(fn);
  }
  getObjectByName(name: string): Object3D | undefined {
    if (this.name === name) return this;
    for (const c of this.children) {
      const f = c.getObjectByName(name);
      if (f) return f;
    }
    return undefined;
  }
  lookAt(): this {
    return this;
  }
  updateMatrixWorld(): void {}
  clone(recursive = true): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(c, this);
    (c as { id: number }).id = nextId++;
    c.position = this.position.clone();
    c.rotation = new Euler().copy(this.rotation);
    c.scale = this.scale.clone();
    c.userData = { ...this.userData };
    c.parent = null;
    c.children = [];
    if (recursive) for (const child of this.children) c.add(child.clone(true));
    return c;
  }
  /** local transform */
  matrix(): Affine {
    return compose(this.position, this.rotation, this.scale);
  }
}

export class Group extends Object3D {}
export class Scene extends Object3D {}

/** An Object3D that is a joint. */
export class Joint extends Object3D {
  constructor(name = "") {
    super();
    this.name = name;
    this.joint = true;
  }
}

export class Mesh extends Object3D {
  constructor(public geometry: BufferGeometry = new BufferGeometry(), public material: Material = new MeshStandardMaterial()) {
    super();
  }
}

// --- flattening -------------------------------------------------------------

/** What a model description needs to know back: joint names to indices. */
export interface ModelLayout {
  readonly desc: Float32Array;
  readonly joints: readonly string[];
  readonly parts: number;
}

interface FlatPart {
  mesh: Mesh;
  m: Affine;
  joint: number;
}

/** Flatten an Object3D tree into a PLAYSET_MODEL description. The root's
 *  rotation and scale are part of the model; its position is not. */
export function describeModel(root: Object3D, options: { jitter?: number; seed?: number } = {}): ModelLayout {
  const parts: FlatPart[] = [];
  const joints: { name: string; parent: number; pivot: [number, number, number] }[] = [];
  const rootMatrix = compose(new Vector3(), root.rotation, root.scale);
  const walk = (o: Object3D, m: Affine, joint: number) => {
    if (!o.visible) return;
    let j = joint;
    if (o.joint && o !== root) {
      const pivot = transformPoint(m, 0, 0, 0);
      joints.push({ name: o.name, parent: joint, pivot });
      j = joints.length - 1;
    }
    if (o instanceof Mesh) parts.push({ mesh: o, m, joint: j });
    for (const c of o.children) walk(c, multiply(m, c.matrix()), j);
  };
  // joint 0 is the root when any joint exists, so unjointed parts have a home
  const hasJoints = (() => {
    let found = false;
    root.traverse((o) => {
      if (o !== root && o.joint) found = true;
    });
    return found;
  })();
  if (hasJoints) joints.push({ name: root.name || "root", parent: -1, pivot: [0, 0, 0] });
  walk(root, rootMatrix, hasJoints ? 0 : -1);
  const raws: Float32Array[] = [];
  let rawLength = 0;
  const rawOffsets: number[] = [];
  const rawCounts: number[] = [];
  for (const p of parts) {
    const g = p.mesh.geometry;
    if (g.kind === PLAYSET_GEOM.RAW && g.positions) {
      // expand an indexed geometry to triangles
      let tri = g.positions;
      if (g.index) {
        tri = new Float32Array(g.index.length * 3);
        for (let i = 0; i < g.index.length; i++) {
          tri[i * 3] = g.positions[g.index[i] * 3];
          tri[i * 3 + 1] = g.positions[g.index[i] * 3 + 1];
          tri[i * 3 + 2] = g.positions[g.index[i] * 3 + 2];
        }
      }
      rawOffsets.push(rawLength);
      rawCounts.push(tri.length / 3);
      raws.push(tri);
      rawLength += tri.length;
    } else {
      rawOffsets.push(-1);
      rawCounts.push(0);
    }
  }
  const head = PLAYSET_MODEL.HEADER;
  const jointAt = head;
  const partAt = jointAt + joints.length * PLAYSET_MODEL.JOINT_STRIDE;
  const rawAt = partAt + parts.length * PLAYSET_MODEL.PART_STRIDE;
  const desc = new Float32Array(rawAt + rawLength);
  desc[0] = PLAYSET_MODEL.VERSION;
  desc[1] = parts.length;
  desc[2] = joints.length;
  desc[3] = rawLength;
  joints.forEach((j, i) => {
    const o = jointAt + i * PLAYSET_MODEL.JOINT_STRIDE;
    desc[o] = j.parent;
    desc[o + 1] = j.pivot[0];
    desc[o + 2] = j.pivot[1];
    desc[o + 3] = j.pivot[2];
  });
  parts.forEach((p, i) => {
    const o = partAt + i * PLAYSET_MODEL.PART_STRIDE;
    const g = p.mesh.geometry;
    const mat = p.mesh.material;
    desc[o + PLAYSET_PART.GEOM] = g.kind;
    if (g.kind === PLAYSET_GEOM.RAW) {
      desc[o + PLAYSET_PART.P0] = rawOffsets[i];
      desc[o + PLAYSET_PART.P1] = rawCounts[i];
    } else {
      for (let k = 0; k < 8 && k < g.params.length; k++) desc[o + PLAYSET_PART.P0 + k] = g.params[k];
    }
    desc[o + PLAYSET_PART.JOINT] = Math.max(p.joint, 0);
    desc[o + PLAYSET_PART.R] = mat.color.r;
    desc[o + PLAYSET_PART.G] = mat.color.g;
    desc[o + PLAYSET_PART.B] = mat.color.b;
    desc[o + PLAYSET_PART.EMISSIVE] = mat.emissiveAmount();
    const opacity = mat.transparent || mat.wireframe ? mat.opacity * (mat.wireframe ? 0.5 : 1) : 1;
    desc[o + PLAYSET_PART.OPACITY] = opacity;
    desc[o + PLAYSET_PART.BLEND] = mat.blending === AdditiveBlending ? PLAYSET_BLEND.ADD : opacity < 1 ? PLAYSET_BLEND.ALPHA : PLAYSET_BLEND.OPAQUE;
    const m = multiply(p.m, g.matrix);
    for (let k = 0; k < 12; k++) desc[o + PLAYSET_PART.M + k] = m[k];
    desc[o + PLAYSET_PART.FLAT] = mat.flatShading ? 1 : 0;
    const jitter = (p.mesh.userData.jitter as number | undefined) ?? options.jitter ?? 0;
    desc[o + PLAYSET_PART.JITTER] = jitter;
    desc[o + PLAYSET_PART.SEED] = (p.mesh.userData.seed as number | undefined) ?? options.seed ?? p.mesh.id;
    desc[o + PLAYSET_PART.NO_BOUNDS] = p.mesh.userData.noBounds ? 1 : 0;
  });
  let at = rawAt;
  for (const r of raws) {
    desc.set(r, at);
    at += r.length;
  }
  return { desc, joints: joints.map((j) => j.name), parts: parts.length };
}
