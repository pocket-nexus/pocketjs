import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depfile } from "../framework/compiler/build-inputs.ts";

const root = new URL("..", import.meta.url).pathname;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

describe("ESP-IDF incremental package build", () => {
  test.each(["checkout", "vendor"])("native %s builds track extracted contract sources", (layout) => {
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs native deps ")));
    try {
      const component = join(temporary, "platforms/esp-idf/pocket_runtime");
      const build = join(temporary, "build");
      mkdirSync(component, { recursive: true });
      mkdirSync(join(component, "tools"));
      for (const file of ["native_archive.cmake", "prepare_archive.cmake", "tools/native_sources.py"])
        cpSync(join(root, "platforms/esp-idf/pocket_runtime", file), join(component, file));
      const native = layout === "vendor" ? join(component, "vendor/native") : join(temporary, "programs/esp-idf/archive");
      const contracts = layout === "vendor" ? join(component, "vendor") : join(temporary, "engine");
      const crates = ["core", "spec", "drivers", "raster", "present", "package", "modules/media", "render/draw-ops", "render/glyph-pages", "render/tri-batch", "render/tex-cache", "runtime", "runtime-cabi"];
      const extra = ["platforms/esp-idf/render-ppa", "devices/gles/pocket-gles", "devices/gles/pocket-gles1", "devices/gles/pocket-gles2"]
        .map(path => layout === "vendor" ? join(contracts, path.split("/").at(-1)!) : join(temporary, path));
      for (const source of [native, ...crates.map(crate => join(contracts, crate)), ...extra]) {
        mkdirSync(join(source, "src"), { recursive: true });
        writeFileSync(join(source, "Cargo.toml"), "# build dependency fixture\n");
        writeFileSync(join(source, "src/lib.rs"), "// build dependency fixture\n");
      }
      const packages = [native, ...crates.map(crate => join(contracts, crate)), ...extra];
      const fakeBin = join(temporary, "bin"); mkdirSync(fakeBin);
      const fakeMetadata = {
        workspace_root: native,
        packages: packages.map((directory, i) => ({ id: String(i), manifest_path: join(directory, "Cargo.toml") })),
        resolve: { nodes: packages.map((_, i) => ({ id: String(i), deps: i === 0 ? packages.slice(1).map((_, j) => ({pkg: String(j + 1), dep_kinds: [{kind: null}]})) : [] })) },
      };
      const fakeCargo = join(fakeBin, "cargo");
      writeFileSync(fakeCargo, `#!/bin/sh\nprintf '%s' ${quote(JSON.stringify(fakeMetadata))}\n`); chmodSync(fakeCargo, 0o755);
      writeFileSync(join(fakeBin, "rustc"), "#!/bin/sh\nexit 0\n"); chmodSync(join(fakeBin, "rustc"), 0o755);
      const compatibility = join(extra[0], "src/cabi.rs");
      writeFileSync(compatibility, "// compatibility source dependency fixture\n");
      writeFileSync(join(temporary, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.20)
project(native_dependencies NONE)
set(IDF_TARGET esp32s3)
set(POCKETJS_RUST_FROM_SOURCE ON CACHE BOOL "" FORCE)
set(POCKETJS_CARGO "${fakeCargo}" CACHE FILEPATH "" FORCE)
# Inspect the archive build graph without linking a firmware component.
function(target_link_libraries)
endfunction()
include("${join(component, "native_archive.cmake")}")
pocketjs_link_native("${component}" runtime pocket_idf_runtime POCKETJS_TEST_ARCHIVE)
`);
      const result = Bun.spawnSync(["cmake", "-S", temporary, "-B", build, "-G", "Ninja"], {
        stdout: "pipe", stderr: "pipe",
      });
      expect(result.success, result.stdout.toString() + result.stderr.toString()).toBe(true);
      const graph = readFileSync(join(build, "build.ninja"), "utf8");
      const archiveEdge = graph.split("\n").find(line => line.startsWith("build cargo/") && line.includes(".a: CUSTOM_COMMAND"));
      expect(archiveEdge).toBeDefined();
      for (const crate of crates) for (const file of ["Cargo.toml", "src/lib.rs"])
        expect(archiveEdge).toContain(join(contracts, crate, file).replaceAll(" ", "$ "));
      for (const source of extra) for (const file of ["Cargo.toml", "src/lib.rs"])
        expect(archiveEdge).toContain(join(source, file).replaceAll(" ", "$ "));
      expect(archiveEdge).toContain(compatibility.replaceAll(" ", "$ "));
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 30_000);

  test("escapes depfile paths", () => {
    const output = depfile("/tmp/a b.pocket", ["/tmp/new #$.ts"]);
    expect(output).toContain("a\\ b.pocket:");
    expect(output).toContain("new\\ \\#$$.ts");
  });

  test("Ninja learns new imports, assets, and compiler receipts without reconfigure", () => {
    // Ninja reports resolved paths; on macOS the temporary directory is a
    // symlink (/var/folders -> /private/var/folders).
    const temporary = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs incremental ")));
    try {
      const app = join(temporary, "app"), build = join(temporary, "build"), bin = join(temporary, "bin");
      mkdirSync(app); mkdirSync(bin);
      mkdirSync(join(app, "node_modules/@pocketjs"), { recursive: true });
      symlinkSync(root, join(app, "node_modules/@pocketjs/framework"), "dir");
      for (const file of ["pocket.json", "pocket.runtime-config.ts", "main.tsx"])
        cpSync(join(root, "tests/esp-idf/examples/smoke", file), join(app, file));
      cpSync(join(root, "tests/esp-idf/examples/smoke/profiles"), join(app, "profiles"), {recursive:true});
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
      writeFileSync(join(app, "dummy.c"), "int dummy(void) { return 0; }\n");
      writeFileSync(join(app, "CMakeLists.txt"), `cmake_minimum_required(VERSION 3.20)
project(incremental C)
add_library(app STATIC dummy.c)
include("${join(root, "platforms/esp-idf/pocket_runtime/project_include.cmake")}")
# Exercise the real compile helper; embedding/firmware linking is tested separately.
function(_pocketjs_package_attach target name package profile)
  add_custom_target(package ALL DEPENDS "\${package}")
endfunction()
pocketjs_compile_app(TARGET app NAME app MANIFEST "${join(app, "pocket.json")}"
  PROJECT_ROOT "${app}"
  COMPILER_RECEIPT "${join(app, "compiler-receipt.json")}")
`);
      const run = (args: string[]) => {
        const result = Bun.spawnSync(args, { cwd: app, env: { ...process.env, PATH: bin + ":" + process.env.PATH }, stdout: "pipe", stderr: "pipe" });
        expect(result.success, result.stdout.toString() + result.stderr.toString()).toBe(true);
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

      run(["cmake", "-S", app, "-B", build, "-G", "Ninja"]);
      expect(ninja()).toContain("app.pocket");
      // The cold depfile tracks the static graph only; the new module is unknown.
      expect(readFileSync(depPath, "utf8")).not.toContain("new-module.ts");
      expectClean(explain());

      // Ninja reloads the depfile only after a real build, so learning the new
      // import costs one genuine rebuild; no cmake reconfigure is involved.
      writeFileSync(join(app, "new-module.ts"), 'export const message="first new module";\n');
      writeFileSync(join(app, "app.tsx"), source(true));
      expect(ninja()).toContain("app.pocket");
      expect(readFileSync(depPath, "utf8")).toContain("new-module.ts");
      const firstPackage = readFileSync(output);
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
      expect(ninja()).toContain("app.pocket");
      expect(readFileSync(output).equals(firstPackage)).toBe(false);
      const exportedProfile = join(build, "pocketjs/app/profile/pocket-profile.json");
      const beforeProfile = readFileSync(exportedProfile, "utf8");
      const profileSource = join(app, "profiles/idf-smoke.ts");
      writeFileSync(profileSource, readFileSync(profileSource, "utf8").replace('"tickHz": 60', '"tickHz": 30'));
      const profileBuild = ninja();
      expect(profileBuild).toContain("pocket_profile.h");
      expect(profileBuild).toContain("app.pocket");
      expect(readFileSync(exportedProfile, "utf8")).not.toBe(beforeProfile);
      // After consuming every pending edge, ninja has no work left.
      expect(ninja()).not.toContain("app.pocket");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }, 120_000);
});
