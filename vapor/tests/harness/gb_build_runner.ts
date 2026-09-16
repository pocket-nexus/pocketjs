#!/usr/bin/env bun
// vapor/tests/harness/gb_build_runner.ts — run one buildGbRom in a child.
//
// Bun's `$` resolves PATH as it was when the process started, so a test that
// wants a shimmed `sdcc` has to launch a fresh process with PATH already set.
// gb-build.test.ts spawns this and reads the JSON line it prints:
//
//   {"ok":true,"romBytes":32768} | {"ok":false,"message":"..."}
//
//   argv: <entry.tsx> <out.gb>

import { compileVaporApp } from "../../compiler/compile.ts";
import { buildGbRom } from "../../compiler/rom.ts";

const [entry, outRom] = process.argv.slice(2);
if (!entry || !outRom) {
  console.error("usage: gb_build_runner.ts <entry.tsx> <out.gb>");
  process.exit(2);
}

const app = compileVaporApp(entry, await Bun.file(entry).text(), "VAPOR TODO", "gb");
try {
  const { romBytes } = await buildGbRom(app, outRom);
  console.log(JSON.stringify({ ok: true, romBytes }));
} catch (e) {
  console.log(
    JSON.stringify({ ok: false, message: String(e instanceof Error ? e.message : e) }),
  );
}
