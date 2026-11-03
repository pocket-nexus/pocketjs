// tests/companion-setup.test.ts — what a service needs from its owner
// (tools/companion/setup.ts) and the programs it keeps running
// (tools/companion/supervise.ts): fields kept 0600 and never answered when
// secret, a vendor tool fetched only with consent, checked, unpacked and
// fetched again when old, `/_setup` the same for every service, and a
// supervised program started again after it exits.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVICE_FACTORIES, ServiceHost, type ServiceProvider } from "../tools/companion/services.ts";
import { currentPlatform, OwnerSetup, type SetupSpec } from "../tools/companion/setup.ts";
import { Supervised } from "../tools/companion/supervise.ts";
import { serviceContext, TEST_CONSOLE } from "./helpers/companion-service.ts";

const dir = mkdtempSync(join(tmpdir(), "companion-setup-"));
const work = mkdtempSync(join(tmpdir(), "companion-setup-work-"));
let server: ReturnType<typeof Bun.serve>;
let archive: Uint8Array;
let downloads = 0;

beforeAll(() => {
  // a vendor's build: a tar.gz holding bin/tool, a script that says its version
  writeFileSync(join(work, "tool"), "#!/bin/sh\necho tool 1.0\n", { mode: 0o755 });
  Bun.spawnSync(["mkdir", "-p", join(work, "pack", "bin")]);
  Bun.spawnSync(["cp", join(work, "tool"), join(work, "pack", "bin", "tool")]);
  Bun.spawnSync(["tar", "-czf", join(work, "tool.tar.gz"), "-C", join(work, "pack"), "bin"]);
  archive = new Uint8Array(readFileSync(join(work, "tool.tar.gz")));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname !== "/tool.tar.gz") return new Response("no", { status: 404 });
      downloads++;
      return new Response(Buffer.from(archive), { headers: { "content-length": String(archive.length) } });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

const spec = (sha256?: string): SetupSpec => ({
  title: "Probe",
  fields: [
    { id: "key", label: "API key", secret: true, pattern: "[0-9a-f]{8}", link: { label: "dashboard", url: "https://example.com/keys" } },
    { id: "name", label: "Name", secret: false, optional: true },
  ],
  tools: [
    {
      id: "probe-tool",
      title: "Probe Tool",
      vendor: "Example",
      terms: "https://example.com/terms",
      builds: { "linux-arm64": { url: `http://127.0.0.1:${server.port}/tool.tar.gz`, archive: "tar.gz", binary: "bin/tool", sha256 }, "darwin-arm64": { url: `http://127.0.0.1:${server.port}/tool.tar.gz`, archive: "tar.gz", binary: "bin/tool", sha256 } },
      refreshAfterDays: 14,
    },
  ],
});

const until = async (check: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (check()) return;
  throw new Error("timed out");
};

describe("owner setup", () => {
  test("a field is checked, kept 0600, and a secret one is never answered", () => {
    let changes = 0;
    const setup = new OwnerSetup(serviceContext(dir, () => {}), "probe", spec(), { platform: "linux-arm64", onChange: () => changes++ });
    expect(setup.state().ready).toBe(false);
    expect(() => setup.set("key", "not hex")).toThrow();
    setup.set("key", " 0123abcd ");
    setup.set("name", "Desk");
    expect(changes).toBe(2);
    expect(setup.value("key")).toBe("0123abcd");
    const state = setup.state();
    expect(state.fields[0]).toMatchObject({ id: "key", set: true, secret: true });
    expect("value" in state.fields[0]!).toBe(false);
    expect(state.fields[1]).toMatchObject({ id: "name", value: "Desk" });
    expect(JSON.stringify(state)).not.toContain("0123abcd");
    const file = join(dir, "services", "probe", "setup.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // another start reads what was kept
    expect(new OwnerSetup(serviceContext(dir, () => {}), "probe", spec(), { platform: "linux-arm64" }).value("key")).toBe("0123abcd");
    setup.clear("name");
    expect(setup.value("name")).toBeNull();
  });

  test("a tool is fetched only after consent, checked, unpacked, and fetched again when old", async () => {
    let now = 1_000_000;
    const good = createHash("sha256").update(archive).digest("hex");
    const setup = new OwnerSetup(serviceContext(dir, () => {}), "probe", spec(good), { platform: "linux-arm64", now: () => now });
    expect(setup.toolPath("probe-tool")).toBeNull();
    expect(setup.state().tools[0]).toMatchObject({ state: "absent", consented: false, terms: "https://example.com/terms" });
    expect(downloads).toBe(0);

    await setup.consent("probe-tool");
    await until(() => setup.state().tools[0]!.state === "ready");
    const path = setup.toolPath("probe-tool")!;
    expect(new TextDecoder().decode(Bun.spawnSync([path]).stdout).trim()).toBe("tool 1.0");
    expect(setup.state()).toMatchObject({ ready: true, tools: [{ consented: true, received: archive.length, total: archive.length }] });
    expect(downloads).toBe(1);

    // past refreshAfterDays the old build answers while a new one comes
    now += 15 * 86_400_000;
    expect(setup.toolPath("probe-tool")).toBe(path);
    await until(() => downloads === 2);

    setup.remove("probe-tool");
    expect(setup.toolPath("probe-tool")).toBeNull();
    expect(existsSync(join(dir, "tools", "probe-tool"))).toBe(false);
  });

  test("a download that does not match its SHA-256 is refused; no build for this computer is said", async () => {
    const setup = new OwnerSetup(serviceContext(dir, () => {}), "probe", spec("00".repeat(32)), { platform: "linux-arm64" });
    await setup.consent("probe-tool");
    await until(() => setup.state().tools[0]!.state === "failed");
    expect(setup.state().tools[0]!.message).toContain("SHA-256");
    expect(setup.toolPath("probe-tool")).toBeNull();
    const elsewhere = new OwnerSetup(serviceContext(dir, () => {}), "probe", spec(), { platform: "linux-x64" });
    expect(elsewhere.state().tools[0]!.state).toBe("unavailable");
    expect(elsewhere.consent("probe-tool")).rejects.toThrow();
    expect(currentPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(currentPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentPlatform("win32", "x64")).toBeNull();
  });

  test("the host answers /_setup for any service that has one", async () => {
    const setupDir = mkdtempSync(join(tmpdir(), "companion-setup-host-"));
    const context = serviceContext(setupDir, () => {});
    SERVICE_FACTORIES.probe = (ctx): ServiceProvider => {
      const setup = new OwnerSetup(ctx, "probe", spec(), { platform: "linux-arm64" });
      return { name: "probe", setup, handle: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode("{}") }) };
    };
    SERVICE_FACTORIES.plain = (): ServiceProvider => ({ name: "plain", handle: async () => ({ status: 200, headers: {}, body: new Uint8Array() }) });
    const host = new ServiceHost(context);
    const call = async (service: string, method: "GET" | "POST", body?: unknown) => {
      const response = await host.handle(
        { url: `https://companion.pocket/${service}/_setup`, method, body: body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body)), timeoutMs: 5_000, maxBytes: 100_000 },
        TEST_CONSOLE,
        { app: "dev.pocket-nexus.probe", services: [service] },
        new AbortController().signal,
      );
      return { status: response!.status, json: JSON.parse(new TextDecoder().decode(response!.body)) };
    };
    try {
      expect((await call("probe", "GET")).json).toMatchObject({ service: "probe", title: "Probe", ready: false });
      expect((await call("probe", "POST", { field: "key", value: "zz" })).status).toBe(400);
      const set = await call("probe", "POST", { field: "key", value: "deadbeef" });
      expect(set.json.fields[0]).toMatchObject({ set: true });
      expect(JSON.stringify(set.json)).not.toContain("deadbeef");
      expect((await call("probe", "POST", { tool: "nope", consent: true })).status).toBe(400);
      expect((await call("plain", "GET")).status).toBe(404);
    } finally {
      host.close();
      delete SERVICE_FACTORIES.probe;
      delete SERVICE_FACTORIES.plain;
      rmSync(setupDir, { recursive: true, force: true });
    }
  });
});

describe("a supervised program", () => {
  test("its lines are read, and it starts again after it exits until stopped", async () => {
    const lines: string[] = [];
    let exits = 0;
    const program = new Supervised({
      name: "probe",
      argv: () => [process.execPath, "-e", "console.log('hello', process.env.PROBE_KEY); console.error('err line'); process.exit(3)"],
      env: () => ({ PROBE_KEY: "k1" }),
      onLine: (line, stream) => lines.push(`${stream}:${line}`),
      onExit: () => exits++,
      minBackoffMs: 50,
      maxBackoffMs: 100,
    });
    program.start();
    await until(() => exits >= 2, 8000);
    program.stop();
    expect(lines).toContain("stdout:hello k1");
    expect(lines).toContain("stderr:err line");
    expect(program.starts).toBeGreaterThanOrEqual(2);
    const after = program.starts;
    await Bun.sleep(300);
    expect(program.starts).toBe(after);
    expect(program.running).toBe(false);
  });

  test("a new supervisor stops the run an earlier one left behind", async () => {
    const pidFile = join(dir, "probe.pid");
    const argv = () => [process.execPath, "-e", "setInterval(() => {}, 1000)"];
    const first = new Supervised({ name: "probe", argv, pidFile });
    first.start();
    const orphan = first.pid!;
    expect(readFileSync(pidFile, "utf8").split("\n")[0]).toBe(String(orphan));
    // the first supervisor is gone without stopping it (a service manager that kills only its main process)
    const second = new Supervised({ name: "probe", argv, pidFile });
    second.start();
    await until(() => {
      try {
        process.kill(orphan, 0);
        return false;
      } catch {
        return true;
      }
    });
    expect(second.pid).not.toBe(orphan);
    expect(second.running).toBe(true);
    second.stop();
  });

  test("argv is read at each start, and nothing starts while it answers null", async () => {
    let binary: string | null = null;
    const seen: string[] = [];
    const program = new Supervised({ name: "probe", argv: () => (binary ? [process.execPath, "-e", `console.log(${JSON.stringify(binary)})`] : null), onLine: (l) => seen.push(l), minBackoffMs: 50 });
    program.start();
    expect(program.running).toBe(false);
    binary = "one";
    program.restart();
    await until(() => seen.includes("one"));
    binary = "two";
    program.restart();
    await until(() => seen.includes("two"));
    program.stop();
  });
});
