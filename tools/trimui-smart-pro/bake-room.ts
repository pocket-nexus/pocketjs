#!/usr/bin/env bun
// Bakes a Pocket Studio room package (rooms/<room>/package) into the single
// file the TrimUI Smart Pro program loads: world-space meshes, ASTC 4x4 mip
// chains of the colour atlases, and the manifest's anchors, cameras and glows.
//
//   bun tools/trimui-smart-pro/bake-room.ts --studio <pocket-studio checkout> --out <room.pak> [--atlas 2048]
//
// The art stays in the Pocket Studio checkout: the output belongs in ignored
// build output. Needs ImageMagick (`magick`) and `astcenc` ($ASTCENC, PATH or
// .pocket-build/toolchains/astcenc/bin/astcenc). The shade atlases feed the web
// room's live shadow maps; this file leaves them out.
//
// File layout, little endian: "PSRM", u32 version, u32 header bytes, the JSON
// header, then the blobs the header's offsets name, from the file's start.
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const studio = resolve(option("--studio") ?? process.env.POCKET_STUDIO_DIR ?? "");
const out = resolve(option("--out") ?? join(root, ".pocket-build/trimui-smart-pro/assets/room.pak"));
const atlasSize = Number(option("--atlas") ?? 2048);
const packageDir = join(studio, "rooms/workshop/package");
if (!existsSync(join(packageDir, "room.json"))) throw new Error(`no room package under ${packageDir}: pass --studio`);

const astcenc = [process.env.ASTCENC, join(root, ".pocket-build/toolchains/astcenc/bin/astcenc"), Bun.which("astcenc")].find((path) => path && existsSync(path));
if (!astcenc) throw new Error("astcenc not found: set $ASTCENC");

const manifest = JSON.parse(readFileSync(join(packageDir, "room.json"), "utf8"));
const glb = readFileSync(join(packageDir, manifest.model));
const jsonBytes = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonBytes).toString("utf8"));
const binStart = 20 + jsonBytes + 8;

const require = createRequire(join(studio, "package.json"));
const DecoderModule = require(join(studio, "node_modules/three/examples/jsm/libs/draco/draco_decoder.js"));
const draco = await DecoderModule();

function decode(primitive: any) {
  const extension = primitive.extensions.KHR_draco_mesh_compression;
  const view = gltf.bufferViews[extension.bufferView];
  const bytes = glb.subarray(binStart + (view.byteOffset ?? 0), binStart + (view.byteOffset ?? 0) + view.byteLength);
  const buffer = new draco.DecoderBuffer();
  buffer.Init(new Int8Array(bytes), bytes.length);
  const decoder = new draco.Decoder();
  const mesh = new draco.Mesh();
  const status = decoder.DecodeBufferToMesh(buffer, mesh);
  if (!status.ok()) throw new Error(status.error_msg());
  const read = (id: number, components: number) => {
    const attribute = decoder.GetAttributeByUniqueId(mesh, id);
    const count = mesh.num_points() * components;
    const pointer = draco._malloc(count * 4);
    decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, draco.DT_FLOAT32, count * 4, pointer);
    const copy = new Float32Array(draco.HEAPF32.buffer, pointer, count).slice();
    draco._free(pointer);
    return copy;
  };
  const position = read(extension.attributes.POSITION, 3);
  const uv = read(extension.attributes.TEXCOORD_0, 2);
  const indexCount = mesh.num_faces() * 3;
  const pointer = draco._malloc(indexCount * 4);
  decoder.GetTrianglesUInt32Array(mesh, indexCount * 4, pointer);
  const indices = new Uint32Array(draco.HEAPU32.buffer, pointer, indexCount).slice();
  draco._free(pointer);
  draco.destroy(mesh);
  draco.destroy(decoder);
  draco.destroy(buffer);
  const vertices = new Float32Array((position.length / 3) * 5);
  for (let i = 0; i < position.length / 3; i++) {
    vertices.set([position[i * 3]!, position[i * 3 + 1]!, position[i * 3 + 2]!, uv[i * 2]!, uv[i * 2 + 1]!], i * 5);
  }
  return { vertices, indices };
}

const blobs: Uint8Array[] = [];
let cursor = 0;
function append(bytes: Uint8Array): number {
  const offset = cursor;
  blobs.push(bytes);
  cursor += bytes.length;
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) {
    blobs.push(new Uint8Array(pad));
    cursor += pad;
  }
  return offset;
}
const asBytes = (view: ArrayBufferView) => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

const meshes = [];
for (const node of gltf.nodes) {
  if (node.matrix || node.translation || node.rotation || node.scale) throw new Error(`room node ${node.name} carries a transform; the bake expects world-space meshes`);
  const mesh = gltf.meshes[node.mesh];
  for (const primitive of mesh.primitives) {
    const { vertices, indices } = decode(primitive);
    meshes.push({
      name: mesh.name,
      atlas: gltf.materials[primitive.material].name,
      vertices: { offset: append(asBytes(vertices)), count: vertices.length / 5 },
      indices: { offset: append(asBytes(indices)), count: indices.length },
    });
  }
}

const scratch = join(dirname(out), "bake-scratch");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
const atlases: Record<string, { size: number; levels: { size: number; offset: number; bytes: number }[] }> = {};
await Promise.all(Object.entries(manifest.atlases as Record<string, string>).map(async ([name, file]) => {
  const levels: { size: number; bytes: Uint8Array }[] = [];
  for (let size = atlasSize, level = 0; size >= 4; size >>= 1, level++) {
    const png = join(scratch, `${name}-${level}.png`);
    const astc = join(scratch, `${name}-${level}.astc`);
    await $`magick ${join(packageDir, file)} -colorspace sRGB -filter Box -resize ${size}x${size}! -alpha off ${png}`.quiet();
    await $`${astcenc} -cl ${png} ${astc} 4x4 -medium -silent`.quiet();
    levels.push({ size, bytes: new Uint8Array(readFileSync(astc).subarray(16)) });
  }
  atlases[name] = { size: atlasSize, levels: [] };
  (atlases[name] as any).pending = levels;
}));
for (const name of Object.keys(manifest.atlases)) {
  const atlas = atlases[name] as any;
  atlas.levels = atlas.pending.map((level: { size: number; bytes: Uint8Array }) => ({ size: level.size, offset: append(level.bytes), bytes: level.bytes.length }));
  delete atlas.pending;
}
rmSync(scratch, { recursive: true, force: true });

const header = {
  id: manifest.id,
  title: manifest.title,
  bounds: manifest.bounds,
  anchors: manifest.anchors,
  cameras: manifest.cameras,
  glows: manifest.glows,
  meshes,
  atlases,
};
function encode(headerBytes: number): Buffer {
  const shifted = JSON.stringify(header, (key, value) => (key === "offset" ? value + (12 + headerBytes) : value));
  return Buffer.from(shifted.padEnd(headerBytes, " "));
}
// Offsets depend on the header's own length: reserve room, then encode into it.
const reserved = Math.ceil((JSON.stringify(header).length + 2048) / 4) * 4;
const headerBuffer = encode(reserved);
const prefix = Buffer.alloc(12);
prefix.write("PSRM", 0, "latin1");
prefix.writeUInt32LE(1, 4);
prefix.writeUInt32LE(reserved, 8);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([prefix, headerBuffer, ...blobs]));
console.log(`room: ${out} (${((12 + reserved + cursor) / 1048576).toFixed(1)} MiB, ${meshes.reduce((sum, mesh) => sum + mesh.indices.count / 3, 0)} triangles, atlas ${atlasSize})`);
