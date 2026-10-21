import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { startBridge, type BridgeEvent } from "../tools/devtools-bridge.ts";
import { bundleHash, fnv1a64, launcherBundleHash } from "../tools/bundle-hash.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { makeVariant } from "../tools/pocket-pack.ts";
import { profileRegistry } from "../tools/profile-resolver.ts";
import profile from "../profiles/psp.ts";

function directory() {
  const base = resolve(import.meta.dir, "../.pocket-build/validation/devtools-package");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(resolve(base, "run-"));
}
function packageBytes(code = "globalThis.frame=()=>{};") {
  const manifest = { $schema: "https://pocketjs.dev/schema/pocket-2.json", pocket: 2,
    id: "dev.pocket.devtools", name: "example", title: "Devtools package", version: "1.0.0",
    engine: { capabilities: { requires: ["text.glyphs.baked"] } },
    app: { entry: "absent.tsx", framework: "solid", output: "example",
      viewport: { fixed: { logical: [480, 272], presentation: "native" } } } };
  const resolved = validateAndResolveBuildPlan(manifest, { target: profile.id }, profileRegistry(profile));
  if (!resolved.ok) throw new Error(JSON.stringify(resolved.diagnostics));
  return encodePocketPackage({ manifest: new TextEncoder().encode(JSON.stringify(manifest)),
    variants: [makeVariant({ target: profile.id, hostAbi: POCKET_BINDING_GENERATION,
      planJson: JSON.stringify(resolved.plan), identity: { id: manifest.id, title: manifest.title, output: "example" },
      js: new TextEncoder().encode(code), pak: new Uint8Array([1, 2, 3]) })] });
}
function mailbox(dir: string, packagePath?: string) {
  const hub = Bun.serve({ port: 0, hostname: "127.0.0.1",
    fetch(request, server) { if (server.upgrade(request)) return; return new Response("upgrade required", { status: 400 }); },
    websocket: { message() {} },
  });
  let waiting: ((event: BridgeEvent) => void) | undefined;
  const bridge = startBridge({ dir, port: hub.port!, dist: dir, packagePath,
    onEvent(event) { if (event.type === "bundle-ok" || event.type === "bundle-mismatch") waiting?.(event); },
  });
  const out = resolve(bridge.boxDir, "out.jsonl");
  return {
    send(bundle: string, app = "example"): Promise<BridgeEvent> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting = undefined; reject(new Error("mailbox verdict timed out")); }, 3000);
        waiting = event => { clearTimeout(timer); waiting = undefined; resolve(event); };
        appendFileSync(out, JSON.stringify({ t: "devStats", data: { app, bundle } }) + "\n");
      });
    },
    stop() { bridge.stop(); hub.stop(true); },
  };
}

test("bridge verifies the explicit original package and rejects valid changed bytes, corruption and identity drift", async () => {
  const dir = directory(), path = resolve(dir, "captured.pocket"), bytes = packageBytes();
  writeFileSync(path, bytes);
  const bridge = mailbox(dir, path);
  try {
    expect((await bridge.send(fnv1a64(bytes))).type).toBe("bundle-ok");
    expect((await bridge.send(fnv1a64(bytes), "another-app")).type).toBe("bundle-mismatch");
    writeFileSync(path, packageBytes("globalThis.frame=()=>42;"));
    expect((await bridge.send(fnv1a64(bytes))).type).toBe("bundle-mismatch");
    const corrupt = bytes.slice(); corrupt[corrupt.length - 1]! ^= 1;
    writeFileSync(path, corrupt);
    writeFileSync(resolve(dir, "example.js"), "legacy code");
    writeFileSync(resolve(dir, "example.pak"), "legacy assets");
    const fallback = bundleHash(resolve(dir, "example.js"), resolve(dir, "example.pak"));
    const rejected = await bridge.send(fallback);
    expect(rejected.type).toBe("bundle-mismatch");
    expect(rejected.detail).toContain("cannot verify package");
  } finally { bridge.stop(); }
});

test("bridge never accepts another neighboring package in place of the selected file", async () => {
  const dir = directory(), selected = resolve(dir, "selected.pocket"), other = packageBytes("globalThis.frame=()=>123;");
  writeFileSync(selected, packageBytes());
  writeFileSync(resolve(dir, "example.pocket"), other);
  const bridge = mailbox(dir, selected);
  try { expect((await bridge.send(fnv1a64(other))).type).toBe("bundle-mismatch"); }
  finally { bridge.stop(); }
});

test("legacy raw bundles and launcher tables retain their existing checks", async () => {
  const dir = directory(), js = resolve(dir, "example.js"), pak = resolve(dir, "example.pak");
  writeFileSync(js, "legacy code"); writeFileSync(pak, "legacy assets");
  const legacy = bundleHash(js, pak), bridge = mailbox(dir);
  try {
    expect((await bridge.send(legacy)).type).toBe("bundle-ok");
    writeFileSync(pak, "changed assets");
    expect((await bridge.send(legacy)).type).toBe("bundle-mismatch");
    mkdirSync(resolve(dir, "packages"));
    writeFileSync(resolve(dir, "packages/example.pocket"), packageBytes());
    writeFileSync(resolve(dir, "packages/guest.pocket"), packageBytes("globalThis.frame=()=>42;"));
    writeFileSync(resolve(dir, "launcher-registry.tsv"), "guest\tdev.guest\tGuest\n");
    expect((await bridge.send(launcherBundleHash(dir, ["example", "guest"]))).type).toBe("bundle-ok");
  } finally { bridge.stop(); }
});

test("invalid explicit inputs fail before mailbox creation and both CLIs require the package argument", () => {
  const dir = directory(), missing = resolve(dir, "missing.pocket");
  expect(() => startBridge({ dir, port: 1, packagePath: missing })).toThrow();
  expect(existsSync(resolve(dir, "pocketjs-dbg/enable"))).toBe(false);
  writeFileSync(missing, "not a package");
  expect(() => startBridge({ dir, port: 1, packagePath: missing })).toThrow();
  for (const script of ["tools/devtools.ts", "tools/devtools-psp.ts"]) {
    const result = Bun.spawnSync([process.execPath, script, "--pocket"],
      { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    expect(result.success).toBe(false);
    expect(result.stderr.toString()).toContain("--pocket requires");
  }
});
