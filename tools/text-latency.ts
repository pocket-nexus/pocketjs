/** Native end-to-end layout latency, including the real 60 Hz delivery gate.
 * Run after building a pak with a font in --slot. No window or GPU required. */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
const root = resolve(import.meta.dir, "..");
if (!existsSync(resolve(root, "hosts/desktop/Cargo.toml")))
  throw Error("The native latency harness requires a PocketJS git checkout");
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    pak: { type: "string" },
    slot: { type: "string", default: "1" },
    document: { type: "string" },
    client: { type: "string" },
  },
});
if (!values.pak)
  throw Error("--pak APP.pak [--slot 1] [--document TEXT] [--client MODULE]");
const original = values.document
  ? await Bun.file(resolve(values.document)).text()
  : "Portable text remains responsive while its worker owns layout.\n".repeat(
      12,
    );
const cases = [{ label: "initial", text: original, width: 386 }];
for (let i = 1; i <= 5; i++)
  cases.push({
    label: `edit-${i}`,
    text: original + "x".repeat(i),
    width: 386,
  });
cases.push({ label: "resize", text: cases.at(-1)!.text, width: 480 });
const client = resolve(
  values.client ?? resolve(root, "framework/src/text-layout.ts"),
);
const directory = resolve(root, ".pocket/text-latency");
mkdirSync(directory, { recursive: true });
const entry = resolve(directory, "driver.ts");
await Bun.write(
  entry,
  `import { createTextLayout } from ${JSON.stringify(client)};
import { runServicePumps } from ${JSON.stringify(resolve(root, "framework/src/services.ts"))};
const cases=${JSON.stringify(cases)};
const doc=createTextLayout(s=>{globalThis.layoutStatus=s.status;});
globalThis.caseCount=cases.length;
globalThis.startCase=i=>{const c=cases[i];globalThis.caseLabel=c.label;doc.update(c.text,{slot:${Number(values.slot)},width:c.width});};
globalThis.frame=()=>runServicePumps();`,
);
const build = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  format: "iife",
  minify: false,
});
if (!build.success) throw Error(build.logs.join("\n"));
const bundle = resolve(directory, "driver.js");
await Bun.write(bundle, build.outputs[0]);
const proc = Bun.spawn(
  [
    "cargo",
    "run",
    "--quiet",
    "--release",
    "--locked",
    "--manifest-path",
    resolve(root, "hosts/desktop/Cargo.toml"),
    "--example",
    "text_latency",
    "--",
    bundle,
    resolve(values.pak),
  ],
  { cwd: root, stdout: "inherit", stderr: "inherit" },
);
process.exit(await proc.exited);
