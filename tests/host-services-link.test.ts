// tests/host-services-link.test.ts — the Pocket Link client every native
// host compiles (engine/host-services/link.c, launcher.c), built for the
// build machine under ASan/UBSan by tests/fixtures/host-services-link.c with
// a POSIX host_services.h, against an in-process companion: pairing, the
// catalog for the console's target, an install streamed into the slot's
// staging file, and net through the companion.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POCKET_BINDING_GENERATION } from "../contracts/spec/binding-generation.ts";
import { POCKET_SECTION, encodeIdentity, encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import { fnv1a64Hex } from "../tools/companion/catalog.ts";
import { Companion } from "../tools/companion/server.ts";
import { CompanionStore } from "../tools/companion/store.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SHARED = join(ROOT, "engine/host-services");

function makePackage(id: string, target: string, padBytes: number): Uint8Array {
  const pad = new Uint8Array(padBytes);
  for (let i = 0; i < pad.length; i++) pad[i] = (i * 31 + 7) & 255;
  return encodePocketPackage({
    manifest: new TextEncoder().encode(JSON.stringify({ pocket: 2, id, title: "Hacker News", version: "1.0.0" })),
    variants: [
      {
        target,
        hostAbi: POCKET_BINDING_GENERATION,
        // The link client stores what the companion sends; no runtime admits it here.
        profileHash: `sha256:${"0".repeat(64)}`,
        sections: [
          { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output: "hn", id, title: "Hacker News" }) },
          { kind: POCKET_SECTION.js, bytes: new TextEncoder().encode("globalThis.x=1;\0") },
          { kind: POCKET_SECTION.pak, bytes: pad },
        ],
      },
    ],
  });
}

describe("engine/host-services link client", () => {
  let scratch = "";
  let binary = "";
  let companion: Companion;
  let web: ReturnType<typeof Bun.serve>;
  let hn: Uint8Array;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "pocket-host-services-"));
    binary = join(scratch, "harness");
    const compile = Bun.spawnSync([
      "cc", "-std=gnu11", "-DPOCKETJS_WORKER_HTTP", "-O1", "-Wall", "-Wextra", "-fsanitize=address,undefined", `-I${SHARED}`, `-I${join(ROOT, "engine/worker/include")}`,
      join(ROOT, "tests/fixtures/host-services-link.c"),
      ...["link.c", "link_http.c", "link_proto.c", "launcher.c", "jscan.c", "sha256.c"].map((file) => join(SHARED, file)),
      "-o", binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);

    const apps = join(scratch, "offer");
    Bun.spawnSync(["mkdir", "-p", apps]);
    hn = makePackage("dev.pocket-nexus.hn", "3ds-dev", 300_000);
    writeFileSync(join(apps, "hn.pocket"), hn);
    writeFileSync(join(apps, "hn.tab5.pocket"), makePackage("dev.pocket-nexus.hn", "tab5-home", 1000));
    companion = new Companion({
      store: new CompanionStore(join(scratch, "store")),
      name: "Test Mac",
      port: 0,
      host: "127.0.0.1",
      appsDirs: [apps],
      allowPrivate: true,
      beacon: false,
      pairHosts: ["127.0.0.1"],
      log: () => {},
    });
    await companion.start();
    web = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => new Response(new URL(request.url).pathname.endsWith("/stream")
      ? Uint8Array.from({ length: 24000 }, (_, i) => (i * 31 + 7) & 255)
      : "hello from the web") });
  });

  afterAll(async () => {
    web?.stop(true);
    await companion?.stop();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("pairs, lists its target's catalog, installs and fetches through the companion", async () => {
    const { uri } = companion.openPairing();
    const run = Bun.spawn(
      [binary, join(scratch, "console"), uri, "dev.pocket-nexus.hn", `http://127.0.0.1:${web.port}/hello`],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toContain("linked 1");
    expect(lines).toContain("status linked");
    const catalog = JSON.parse(lines.find((line) => line.startsWith("catalog "))!.slice("catalog ".length));
    expect(catalog[0].apps).toEqual([
      expect.objectContaining({ id: "dev.pocket-nexus.hn", bytes: hn.length, hash: fnv1a64Hex(hn.subarray(0, hn.length - 8)) }),
    ]);
    expect(lines.find((line) => line.startsWith("installed ")), stdout).toMatch(new RegExp(`^installed [0-9a-f]{16} ${hn.length} 1$`));
    const install = JSON.parse(lines.find((line) => line.startsWith("install "))!.slice("install ".length));
    expect(install.at(-1)).toMatchObject({ t: "install.done", app: "dev.pocket-nexus.hn", output: "hn" });
    expect(lines).toContain("stream 24000 1");
  }, 60_000);
});
