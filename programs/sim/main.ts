import { resolve } from "node:path";
import { bootBundle } from "./sim.ts";

const directory = import.meta.dir;
const metadata = await Bun.file(resolve(directory, "program.json")).json();
const frames = Number(Bun.argv[2] ?? 1);
if (!Number.isInteger(frames) || frames < 0 || frames > 100000) throw new Error("frame count must be an integer from 0 to 100000");
const world = await bootBundle({ ...metadata, js: resolve(directory, metadata.js), pak: resolve(directory, metadata.pak), wasm: resolve(directory, "pocketjs.wasm") });
for (let index = 0; index < frames; index++) world.step();
console.log(JSON.stringify({ frames, viewport: world.viewport, failure: world.failure }));
if (world.failure) process.exitCode = 1;
