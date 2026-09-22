import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { depfile } from "../framework/compiler/build-inputs.ts";

const root = new URL("..", import.meta.url).pathname;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("ESP-IDF incremental package build", () => {
  test("escapes depfile paths", () => {
    const output = depfile("/tmp/a b.pocket", ["/tmp/new #$.ts"]);
    expect(output).toContain("a\\ b.pocket:");
    expect(output).toContain("new\\ \\#$$.ts");
  });

  test("Ninja learns new imports, assets, and compiler receipts without reconfigure", () => {
    const temporary = mkdtempSync(join(tmpdir(), "pocketjs incremental "));
    try {
      const app = join(temporary, "app"), build = join(temporary, "build"), bin = join(temporary, "bin");
      mkdirSync(app); mkdirSync(bin);
      mkdirSync(join(app, "node_modules/@pocketjs"), { recursive: true });
      symlinkSync(root, join(app, "node_modules/@pocketjs/framework"), "dir");
      for (const file of ["pocket.json", "pocket.host.json", "main.tsx"])
        cpSync(join(root, "hosts/esp-idf/examples/smoke", file), join(app, file));
      const source = (imported: boolean) =>
        'import {Text, View, Image} from "@pocketjs/framework/solid/components";\n' +
        (imported ? 'import {message} from "./new-module";\n' : 'const message="initial";\n') +
        'export default function App(){return <View class="w-full h-full"><Text class="text-base">{message}</Text><Image src="asset.svg" /></View>}';
      writeFileSync(join(app, "app.tsx"), source(false));
      const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="${color}"/></svg>`;
      writeFileSync(join(app, "asset.svg"), svg("#ff0000"));
      writeFileSync(join(app, "compiler-receipt.json"), '{"revision":1}\n');
      const cli = join(bin, "pocket");
      writeFileSync(cli, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(root, "tools/pocket.ts"))} "$@"\n`);
      chmodSync(cli, 0o755);
      writeFileSync(join(app, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.20)
project(incremental NONE)
include("${join(root, "hosts/esp-idf/components/pocketjs_package/project_include.cmake")}")
# Exercise the real compile helper; embedding/firmware linking is tested separately.
function(_pocketjs_package_attach target name package profile)
  add_custom_target(package ALL DEPENDS "\${package}")
endfunction()
pocketjs_compile_app(TARGET app NAME app MANIFEST "${join(app, "pocket.json")}"
  HOST_PROFILE "${join(app, "pocket.host.json")}" PROJECT_ROOT "${app}"
  COMPILER_RECEIPT "${join(app, "compiler-receipt.json")}")
`);
      const run = (args: string[]) => {
        const result = Bun.spawnSync(args, { cwd: app, env: { ...process.env, PATH: bin + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
        return result.stdout.toString() + result.stderr.toString();
      };
      // Real build: the compile recipe runs and the package banner is printed.
      const ninja = () => run(["cmake", "--build", build]);
      // Incremental evidence without executing the recipe: ninja's dry run plus
      // -d explain reports the precise input that makes the edge dirty. A dry
      // run does not touch outputs, so dirty edges accumulate across edits and
      // a later real build consumes them all at once.
      const explain = () => run(["cmake", "--build", build, "--", "-n", "-d", "explain"]);
      const expectDirty = (output: string, file: string) => {
        expect(output).toContain("Generating pocketjs/app/app.pocket");
        expect(output).toContain(`most recent input ${file}`);
      };
      const expectClean = (output: string) => {
        expect(output).not.toContain("Generating pocketjs/app/app.pocket");
      };

      const output = join(build, "pocketjs/app/app.pocket");
      const depPath = join(build, "pocketjs/app/app.d");
      const jsPath = join(build, "pocketjs/app/idf-smoke.js");
      const pakPath = join(build, "pocketjs/app/idf-smoke.pak");

      run(["cmake", "-S", app, "-B", build, "-G", "Ninja"]);
      expect(ninja()).toContain("ESP-IDF package");
      // The cold depfile tracks the static graph only; the new module is unknown.
      expect(readFileSync(depPath, "utf8")).not.toContain("new-module.ts");
      expectClean(explain());

      // Ninja reloads the depfile only after a real build, so learning the new
      // import costs one genuine rebuild; no cmake reconfigure is involved.
      writeFileSync(join(app, "new-module.ts"), 'export const message="first new module";\n');
      writeFileSync(join(app, "app.tsx"), source(true));
      expect(ninja()).toContain("ESP-IDF package");
      expect(readFileSync(depPath, "utf8")).toContain("new-module.ts");
      const firstPackage = readFileSync(output);
      const firstJs = sha256(jsPath);
      const firstPak = sha256(pakPath);
      expectClean(explain());

      // Each edit is attributed by ninja's own dependency graph; the recipe
      // itself stays unexecuted until the coalesced build below.
      writeFileSync(join(app, "new-module.ts"), 'export const message="second new module";\n');
      expectDirty(explain(), join(app, "new-module.ts"));
      writeFileSync(join(app, "asset.svg"), svg("#0000ff"));
      expectDirty(explain(), join(app, "asset.svg"));
      writeFileSync(join(app, "compiler-receipt.json"), '{"revision":2}\n');
      expectDirty(explain(), join(app, "compiler-receipt.json"));

      // One real build consumes the three pending dirty inputs.
      expect(ninja()).toContain("ESP-IDF package");
      expect(readFileSync(output).equals(firstPackage)).toBe(false);
      // Channel attribution: the module edit reaches the JS bundle, the asset
      // edit reaches the PAK; they are independent build outputs.
      expect(sha256(jsPath)).not.toBe(firstJs);
      expect(sha256(pakPath)).not.toBe(firstPak);
      // After consuming every pending edge, ninja has no work left.
      expect(ninja()).not.toContain("ESP-IDF package");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 120_000);
});
