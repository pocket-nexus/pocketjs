import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeIdentity, encodePocketPackage, POCKET_SECTION } from "../contracts/spec/pocket-package.ts";
import { atomicWrite, VitaUsbClient } from "../tools/vita-dev-client.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function client(timeout = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "pocket-vita-usb-")); dirs.push(dir);
  const client = new VitaUsbClient(dir, "P12345678", timeout);
  const session = client.startSession();
  const status = { session, titleId: client.titleId, nativeBuild: "a".repeat(32), frame: 42, error: "" };
  atomicWrite(join(client.directory, "status.json"), JSON.stringify(status));
  return { client, status };
}

test("USB client rejects stale and other-session status", () => {
  const { client: c } = client();
  expect(c.status().frame).toBe(42);
  const path = join(c.directory, "status.json");
  utimesSync(path, new Date(0), new Date(0));
  expect(() => c.status()).toThrow("stale");
  c.startSession();
  expect(() => c.status()).toThrow("stale");
});

test("USB command waits for the matching completed receipt", async () => {
  const { client: c } = client();
  const operation = c.command("push", { payload: Buffer.from("candidate") });
  const request = JSON.parse(readFileSync(join(c.directory, "request.json"), "utf8"));
  expect(readFileSync(join(c.directory, `${request.id}.payload`), "utf8")).toBe("candidate");
  atomicWrite(join(c.directory, `${request.id}.json`), JSON.stringify({ ...request, phase: "complete", ok: true, data: { generation: 2 } }));
  expect((await operation).generation).toBe(2);
  expect(existsSync(join(c.directory, "request.json"))).toBe(false);
  expect(existsSync(join(c.directory, `${request.id}.payload`))).toBe(false);
  expect(existsSync(join(c.directory, `${request.id}.json`))).toBe(true);
});

for (const gap of ["missing", "stale"] as const) test(`a ${gap} status delays publication until the live status returns`, async () => {
  const { client: c, status } = client();
  const path = join(c.directory, "status.json");
  if (gap === "missing") rmSync(path);
  else utimesSync(path, new Date(0), new Date(0));
  const operation = c.command("status");
  await Bun.sleep(50);
  expect(existsSync(join(c.directory, "request.json"))).toBe(false);
  atomicWrite(path, JSON.stringify(status));
  for (let i = 0; i < 20 && !existsSync(join(c.directory, "request.json")); i++) await Bun.sleep(10);
  const request = JSON.parse(readFileSync(join(c.directory, "request.json"), "utf8"));
  atomicWrite(join(c.directory, `${request.id}.json`), JSON.stringify({ ...request, phase: "complete", ok: true, data: status }));
  expect((await operation).frame).toBe(42);
});

test("a missing runtime status times out without publishing an upload", async () => {
  const { client: c } = client(60);
  rmSync(join(c.directory, "status.json"));
  await expect(c.command("push", { payload: Buffer.from("candidate") })).rejects.toThrow("ENOENT");
  expect(existsSync(join(c.directory, "request.json"))).toBe(false);
  expect(existsSync(join(c.directory, "command.lock"))).toBe(false);
});

test("a rejected update is retired so the next process cannot replay it", async () => {
  const { client: c } = client();
  const operation = c.command("native", { payload: Buffer.from("SELF"), build: "b".repeat(32) });
  const request = JSON.parse(readFileSync(join(c.directory, "request.json"), "utf8"));
  atomicWrite(join(c.directory, `${request.id}.json`), JSON.stringify({ ...request, phase: "complete", ok: false, error: "write denied" }));
  await expect(operation).rejects.toThrow("write denied");
  expect(existsSync(join(c.directory, "request.json"))).toBe(false);
  expect(existsSync(join(c.directory, `${request.id}.payload`))).toBe(false);
});

test("native staging alone is never accepted as a running build", async () => {
  const { client: c } = client(120);
  const operation = c.command("native", { payload: Buffer.from("SELF"), build: "b".repeat(32) });
  const request = JSON.parse(readFileSync(join(c.directory, "request.json"), "utf8"));
  atomicWrite(join(c.directory, `${request.id}.json`), JSON.stringify({ ...request, phase: "staged" }));
  await expect(operation).rejects.toThrow("no completion receipt");
  expect(existsSync(join(c.directory, "request.json"))).toBe(true);
  expect(existsSync(join(c.directory, `${request.id}.payload`))).toBe(true);
});

test("native replacement needs the new build to render without an error", async () => {
  const { client: c, status } = client();
  const operation = c.command("native", { payload: Buffer.from("SELF"), build: "b".repeat(32) });
  atomicWrite(join(c.directory, "status.json"), JSON.stringify({ ...status, nativeBuild: "b".repeat(32), frame: 3 }));
  expect((await operation).nativeBuild).toBe("b".repeat(32));
});

test("concurrent commands cannot overwrite the mailbox request", async () => {
  const { client: c } = client(120);
  const operation = c.command("capture");
  await expect(c.command("reload")).rejects.toThrow("owns this session");
  await expect(operation).rejects.toThrow("no completion receipt");
});

test("timed-out uploads fence later commands until a late completion retires them", async () => {
  for (const ok of [true, false]) {
    const { client: c } = client(120);
    await expect(c.command("push", { payload: Buffer.from("candidate") })).rejects.toThrow("no completion receipt");
    const path = join(c.directory, "request.json");
    const previous = readFileSync(path, "utf8");
    const request = JSON.parse(previous);
    await expect(c.command("reset")).rejects.toThrow("still pending");
    expect(readFileSync(path, "utf8")).toBe(previous);
    expect(readFileSync(join(c.directory, `${request.id}.payload`), "utf8")).toBe("candidate");
    atomicWrite(join(c.directory, `${request.id}.json`), JSON.stringify({ ...request, phase: "complete", ok, data: {}, error: "rejected" }));
    const next = c.command("reset");
    const reset = JSON.parse(readFileSync(path, "utf8"));
    expect(reset.id).not.toBe(request.id);
    expect(existsSync(join(c.directory, `${request.id}.payload`))).toBe(false);
    atomicWrite(join(c.directory, `${reset.id}.json`), JSON.stringify({ ...reset, phase: "complete", ok: true, data: { generation: 3 } }));
    expect((await next).generation).toBe(3);
  }
});

test("a new host session cannot retire old uploads before the worker joins it", async () => {
  const { client: c, status } = client(120);
  await expect(c.command("push", { payload: Buffer.from("candidate") })).rejects.toThrow("no completion receipt");
  const path = join(c.directory, "request.json");
  const previous = readFileSync(path, "utf8");
  const request = JSON.parse(previous);
  const session = c.startSession();
  await expect(c.command("status")).rejects.toThrow("stale");
  expect(readFileSync(path, "utf8")).toBe(previous);
  atomicWrite(join(c.directory, "status.json"), JSON.stringify({ ...status, session }));
  const next = c.command("status");
  const current = JSON.parse(readFileSync(path, "utf8"));
  expect(existsSync(join(c.directory, `${request.id}.payload`))).toBe(false);
  atomicWrite(join(c.directory, `${current.id}.json`), JSON.stringify({ ...current, phase: "complete", ok: true, data: { frame: 45 } }));
  expect((await next).frame).toBe(45);
});

test("native replacement rejects the running build before publishing or writing payloads", async () => {
  const { client: c, status } = client();
  await expect(c.command("native", { payload: Buffer.from("SELF"), build: status.nativeBuild })).rejects.toThrow("already running");
  expect(existsSync(join(c.directory, "request.json"))).toBe(false);
  expect(existsSync(join(c.directory, "command.lock"))).toBe(false);
});

test("a native success response cannot substitute for replacement-process frames", async () => {
  const { client: c, status } = client(120);
  const build = "b".repeat(32);
  const operation = c.command("native", { payload: Buffer.from("SELF"), build });
  const request = JSON.parse(readFileSync(join(c.directory, "request.json"), "utf8"));
  atomicWrite(join(c.directory, `${request.id}.json`), JSON.stringify({ ...request, phase: "complete", ok: true, data: {} }));
  atomicWrite(join(c.directory, "status.json"), JSON.stringify({ ...status, nativeBuild: build, frame: 0 }));
  await expect(operation).rejects.toThrow("no completion receipt");
  await expect(c.command("reset")).rejects.toThrow("still pending");
  atomicWrite(join(c.directory, "status.json"), JSON.stringify({ ...status, nativeBuild: build, frame: 3 }));
  const next = c.command("status");
  const current = JSON.parse(readFileSync(join(c.directory, "request.json"), "utf8"));
  atomicWrite(join(c.directory, `${current.id}.json`), JSON.stringify({ ...current, phase: "complete", ok: true, data: { nativeBuild: build } }));
  expect((await next).nativeBuild).toBe(build);
});

test("a replacement guest error reports failure and leaves recovery commands available", async () => {
  const { client: c, status } = client();
  const build = "b".repeat(32);
  const operation = c.command("native", { payload: Buffer.from("SELF"), build });
  atomicWrite(join(c.directory, "status.json"), JSON.stringify({ ...status, nativeBuild: build, frame: 3, error: "guest failed" }));
  await expect(operation).rejects.toThrow("replacement guest failed");
  const next = c.command("reset");
  const request = JSON.parse(readFileSync(join(c.directory, "request.json"), "utf8"));
  atomicWrite(join(c.directory, `${request.id}.json`), JSON.stringify({ ...request, phase: "complete", ok: true, data: { generation: 1 } }));
  expect((await next).generation).toBe(1);
});

test("device Rust admission consumes the TypeScript package format", async () => {
  const directory = resolve(".pocket-build/validation/vita-usb-contract/fixtures");
  mkdirSync(directory, { recursive: true });
  const plan = JSON.parse(readFileSync("tests/fixtures/plans/portable-vita.plan.json", "utf8"));
  writeFileSync(join(directory, "plan.json"), JSON.stringify(plan));
  function pkg(overrides: { id?: string; abi?: number; target?: string; plan?: unknown; js?: string } = {}) {
    return encodePocketPackage({ manifest: Buffer.from("{}"), variants: [{ target: overrides.target ?? "vita", hostAbi: overrides.abi ?? 2,
      sections: [
        { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: plan.app.output, id: overrides.id ?? plan.app.id, title: plan.app.title }) },
        { kind: POCKET_SECTION.plan, bytes: Buffer.from(JSON.stringify(overrides.plan ?? plan)) },
        { kind: POCKET_SECTION.js, bytes: Buffer.from(overrides.js ?? "globalThis.frame = () => {};\0") },
        { kind: POCKET_SECTION.pak, bytes: new Uint8Array() },
      ] }] });
  }
  const badHash = pkg(); badHash[badHash.length - 1] ^= 1;
  for (const [name, bytes] of Object.entries({ "good": pkg(), "bad-hash": badHash,
    "wrong-app": pkg({ id: "other.app" }), "wrong-abi": pkg({ abi: 99 }),
    "wrong-native": pkg({ plan: { ...plan, viewport: { ...plan.viewport, rasterDensity: 1 } } }),
    "wrong-target": pkg({ target: "psp" }), "no-nul": pkg({ js: "globalThis.frame = () => {};" }),
  })) writeFileSync(join(directory, `${name}.pocket`), bytes);
  const child = Bun.spawn(["cargo", "test", "--locked", "--manifest-path", "tests/fixtures/vita-dev/Cargo.toml", "--target-dir", ".pocket-build/validation/vita-usb-contract/target"],
    { env: { ...process.env, VITA_DEV_FIXTURES: directory }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(stdout + stderr);
  expect(stdout).toContain("8 passed");
}, 120_000);
