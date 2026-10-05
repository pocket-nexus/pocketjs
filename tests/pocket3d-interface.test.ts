import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// skills/pocket3d-interface is the procedure for a Pocket3D game's 2D layer:
// one PocketJS app over the scene. It names files and functions of this
// repository; this test fails when one of them moves.
const ROOT = new URL("..", import.meta.url).pathname;
const skill = readFileSync(ROOT + "skills/pocket3d-interface/SKILL.md", "utf8");
const read = (path: string) => readFileSync(ROOT + path, "utf8");

test("the skill has its front matter and every path it links exists", () => {
  expect(skill).toMatch(/^---\nname: pocket3d-interface\ndescription: /);
  const links = [...skill.matchAll(/\]\(\.\.\/\.\.\/([^)#]+)/g)].map(([, path]) => path);
  expect(links.length).toBeGreaterThan(3);
  for (const path of links) expect([path, existsSync(ROOT + path)]).toEqual([path, true]);
  expect(read("pocket3d/README.md")).toContain("(../skills/pocket3d-interface/SKILL.md)");
});

test("the entry points the skill names are in the sources it names", () => {
  const named: [string, string[]][] = [
    ["framework/src/overlay-host.ts", ["connectOverlay", "pocket.overlay"]],
    ["framework/src/hot.ts", ["export function text", "export function prop"]],
    ["framework/src/modality.ts", ["surfaceHasTouch", "export function glyph"]],
    ["framework/src/actions.ts", ["export function useActions"]],
    ["hosts/3ds/src/svcwire.h", ["svcwire_open", "svcwire_recv_lines", "svcwire_send_line"]],
    ["hosts/3ds/src/qjs.h", ["qjs_boot", "qjs_frame"]],
    ["hosts/3ds/src/gfx.h", ["gfx_prepare_surface", "gfx_draw_surface"]],
    ["hosts/psp/src/ge.rs", ["pub unsafe fn render_over"]],
    ["hosts/psp/src/pak.rs", ["pub fn feed"]],
    ["hosts/psp/src/ffi.rs", ["pub unsafe fn register", "init_ui"]],
    ["hosts/vita/src/lib.rs", ["pub unsafe fn frame_with_input", "pub unsafe fn render_over", "pub unsafe fn eval"]],
    ["engine/quickjs-c/pocket_runtime.c", ["POCKET_SVC_WIRE"]],
    ["tools/3ds-profile.ts", ["export function resolve3dsBuildPlan"]],
    ["framework/src/manifest/resolve.ts", ["validateAndResolveBuildPlan"]],
    ["hosts/web/wasm-ops.js", ["createAuxiliarySurface", "renderScaled"]],
  ];
  for (const [path, names] of named) {
    const source = read(path);
    for (const name of names) expect([path, name, source.includes(name)]).toEqual([path, name, true]);
    // the skill mentions the file or the name it relies on
    expect([path, names.some((name) => skill.includes(name.replace(/^(export function |pub unsafe fn |pub fn )/, ""))) || skill.includes(path)]).toEqual([path, true]);
  }
});

test("the manifest fragment in the skill resolves on every handheld shape", () => {
  const fragment = /```json\n("app": \{[\s\S]*?)\n```/.exec(skill)?.[1];
  expect(fragment).toBeDefined();
  const app = JSON.parse(`{${fragment}}`).app;
  expect(app.presentations.map((p: { id: string }) => p.id)).toEqual(["dual-screen", "touch"]);
  expect(app.presentations[0].modality).toEqual({ screens: 2, touch: "auxiliary" });
  expect(app.presentations[1].modality).toEqual({ touch: "primary", buttons: false });
});
