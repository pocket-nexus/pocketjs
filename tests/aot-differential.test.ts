import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { analyzeSolidAot } from "../microts/compiler/aot-solid-frontend.ts";
import { emitAot } from "../microts/compiler/aot-codegen.ts";
import { jsxPlugin } from "../framework/compiler/jsx-plugin.ts";

// One source graph, initial fixture, and input tape drive stock Solid and native
// generated Rust. Trace order and every frame's tree are compared, including the
// final disposal. Style values are resolved colors, never process-local IDs.
test("Solid and Rust agree frame by frame on keyed dispatch, owned events and lifecycle rounds", async () => {
  const fixture = resolve("tests/fixtures/aot/differential");
  const run = resolve(".pocket-build/validation/solid-aot/differential", String(Date.now()));
  await mkdir(resolve(run, "src"), { recursive: true });
  const program = analyzeSolidAot(resolve(fixture, "App.tsx"), { strict: true });
  await Bun.write(resolve(run, "src/generated.rs"), emitAot(program).files["app.rs"]!);
  await Bun.write(resolve(run, "src/main.rs"), Bun.file(resolve(fixture, "native.rs")));
  await Bun.write(resolve(run, "styles.bin"), new Uint8Array(program.styles.bytes));
  await Bun.write(resolve(run, "Cargo.toml"), `[package]\nname="aot-differential"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[dependencies]\nmicrots={path=${JSON.stringify(resolve("engine/crates/microts"))},features=["std"]}\nserde_json="1"\n`);
  const wasmBuild = Bun.spawnSync([process.execPath, "tools/wasm.ts"], { stdout: "pipe", stderr: "pipe" });
  await Bun.write(resolve(run, "wasm-build.log"), wasmBuild.stdout.toString() + wasmBuild.stderr.toString());
  expect(wasmBuild.exitCode, wasmBuild.stderr.toString()).toBe(0);

  const oracle = resolve(run, "oracle.ts");
  await Bun.write(oracle, `
import { render } from ${JSON.stringify(resolve("framework/src/index.ts"))};
import { rootMirror } from ${JSON.stringify(resolve("framework/src/renderer-solid.ts"))};
import { getFocused } from ${JSON.stringify(resolve("framework/src/input.ts"))};
import { createWasmUi } from ${JSON.stringify(resolve("hosts/web/wasm-ops.js"))};
import App from ${JSON.stringify(resolve(fixture, "App.tsx"))};
import { trace } from ${JSON.stringify(resolve(fixture, "App.ts"))};
import tape from ${JSON.stringify(resolve(fixture, "tape.json"))};
const wasm = await createWasmUi(await Bun.file(${JSON.stringify(resolve("hosts/web/pocketjs.wasm"))}).arrayBuffer());
wasm.ops.loadStyles(new Uint8Array(${JSON.stringify(program.styles.bytes)}));
const dispose = render(() => App(), { ops: wasm.ops, styles: ${JSON.stringify(program.styles.ids)} });
const appRootId = rootMirror.children[0].id;
const contents = id => { const node = wasm.inspectNode(id); return node.text + node.children.map(contents).join(""); };
const tree = id => { const node = wasm.inspectNode(id); return node.display === 1 ? null : ({ type: node.type,
  text: node.type === 1 ? contents(id) : "", style: node.style, children: node.type === 1 ? [] : node.children.map(tree).filter(Boolean) }); };
const snapshot = () => {
  if (wasm.focused() !== (getFocused()?.id ?? 0)) throw new Error("Solid mirror focus differs from the retained core");
  return { tree: wasm.inspectNode(appRootId)?.children.map(tree).filter(Boolean) ?? [], trace: trace.splice(0), focus: getFocused()?.debugName ?? null };
};
export function check() {
  const frames = [];
  for (const sample of tape) { globalThis.frame(sample.buttons, 0, [], [], [], 0, [{ axis: 0, delta: sample.axis ?? 0 }], sample.motion ?? null); wasm.tick(); frames.push(snapshot()); }
  dispose(); frames.push(snapshot());
  return frames;
}
console.log(JSON.stringify(check()));
`);
  const build = await Bun.build({ entrypoints: [oracle], target: "bun", format: "esm", conditions: ["browser"], plugins: [jsxPlugin("solid")] });
  expect(build.success, build.logs.join("\n")).toBe(true);
  const bundle = resolve(run, "oracle.mjs");
  await Bun.write(bundle, build.outputs[0]!);
  // Simulator tests install host globals such as __pak. Run both oracles in
  // fresh processes so an earlier app cannot replace this fixture's styles.
  const oracleRun = Bun.spawnSync([process.execPath, bundle], { stdout: "pipe", stderr: "pipe" });
  await Bun.write(resolve(run, "solid.log"), oracleRun.stderr);
  expect(oracleRun.exitCode, oracleRun.stderr.toString()).toBe(0);
  const solid = JSON.parse(oracleRun.stdout.toString());
  const native = Bun.spawnSync(["cargo", "run", "--quiet", "--manifest-path", resolve(run, "Cargo.toml"), "--", resolve(fixture, "fixture.json"), resolve(fixture, "tape.json"), resolve(run, "styles.bin")], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: resolve(".pocket-build/validation/solid-aot/differential/target") },
  });
  await Bun.write(resolve(run, "native.log"), native.stderr);
  expect(native.exitCode, native.stderr.toString()).toBe(0);
  const rust = JSON.parse(native.stdout.toString());
  await Bun.write(resolve(run, "solid.json"), JSON.stringify(solid, null, 2));
  await Bun.write(resolve(run, "rust.json"), JSON.stringify(rust, null, 2));
  expect(rust.length).toBe(solid.length);
  for (let frame = 0; frame < solid.length; frame++) expect(rust[frame], `differential frame ${frame}; artifacts: ${run}`).toEqual(solid[frame]);
}, 120_000);
