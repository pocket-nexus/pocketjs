// Pocket Link companion (tools/companion/*) against contracts/spec/link.ts:
// protocol vectors, the handshake in both modes through the reference console
// client, net / catalog / install over a live loopback link, the control API,
// and the pairing QR encoder.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LINK_BEACON_BYTES,
  LINK_FRAME,
  LINK_MAX_DATA,
  LINK_MAX_FRAME,
  LINK_PAIR_URI_MAX,
  LINK_REFUSAL,
} from "../contracts/spec/link.ts";
import { NET_ERROR } from "../contracts/spec/net.ts";
import { POCKET_SECTION, encodeIdentity, encodePocketPackage, fnv1a64 } from "../contracts/spec/pocket-package.ts";
import { encodePNG } from "../tools/png.ts";
import { fnv1a64Hex } from "../tools/companion/catalog.ts";
import { LinkConsoleClient, LinkNetError, LinkRefused, listenBeacons, type ConsoleDevice } from "../tools/companion/console-client.ts";
import { controlRequest, readControl, startControl } from "../tools/companion/control.ts";
import { isPrivateAddress } from "../tools/companion/fetch.ts";
import {
  LinkFrameDecoder,
  LinkProtocolError,
  buildPairUri,
  companionProof,
  consoleProof,
  decodeBeacon,
  encodeBeacon,
  encodeCtrl,
  encodeData,
  encodeFrame,
  encodePreamble,
  maskKey,
  parsePairUri,
} from "../tools/companion/protocol.ts";
import { byteCapacity, encodeQr, functionModules, rasterizeQr, type QrCode } from "../tools/companion/qr.ts";
import { Companion } from "../tools/companion/server.ts";
import { CompanionStore } from "../tools/companion/store.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "pocket-link-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let dirCount = 0;
const freshDir = (label: string) => {
  const dir = join(tmpRoot, `${label}-${dirCount++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const DEVICE: ConsoleDevice = { id: "0123456789abcdef", name: "Evan 3DS", model: "n3ds", target: "3ds-dev" };

// ---------------------------------------------------------------------------
// Protocol vectors
// ---------------------------------------------------------------------------

describe("protocol", () => {
  const h = {
    nD: "00112233445566778899aabbccddeeff",
    nC: "ffeeddccbbaa99887766554433221100",
    device: "0123456789abcdef",
    companion: "fedcba9876543210",
  };
  const key = "a".repeat(64);
  const hmac = (secret: string, message: string) => createHmac("sha256", Buffer.from(secret, "hex")).update(message).digest("hex");

  test("proofs are HMAC-SHA256 over the label strings from link.ts", () => {
    const tail = `\n${h.nD}\n${h.nC}\n${h.device}\n${h.companion}`;
    expect(companionProof(key, h)).toBe(hmac(key, `pocket-link/1/companion${tail}`));
    expect(consoleProof(key, h)).toBe(hmac(key, `pocket-link/1/console${tail}`));
    expect(companionProof(key, h)).not.toBe(consoleProof(key, h));
    // Pinned so a C or Rust implementation can check itself against the same vector.
    expect(companionProof(key, h)).toBe(hmac("aa".repeat(32), `pocket-link/1/companion${tail}`));
  });

  test("the pairing key travels masked with HMAC(secret, key label + nonces)", () => {
    const secret = "0f".repeat(16);
    const mask = Buffer.from(hmac(secret, `pocket-link/1/key\n${h.nD}\n${h.nC}`), "hex");
    const linkKey = "5a".repeat(32);
    const masked = maskKey(linkKey, secret, h.nD, h.nC);
    const expected = Buffer.from(linkKey, "hex").map((b, i) => b ^ mask[i]);
    expect(masked).toBe(Buffer.from(expected).toString("hex"));
    expect(maskKey(masked, secret, h.nD, h.nC)).toBe(linkKey);
  });

  test("beacon layout", () => {
    const bytes = encodeBeacon({ pairing: true, port: 8628, companion: h.companion, name: "Studio Mac" });
    expect(bytes.length).toBe(LINK_BEACON_BYTES);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("PKLB");
    expect(bytes[4]).toBe(1);
    expect(bytes[5]).toBe(1);
    expect(bytes[6] | (bytes[7] << 8)).toBe(8628);
    expect(new TextDecoder().decode(bytes.subarray(8, 24))).toBe(h.companion);
    expect(new TextDecoder().decode(bytes.subarray(24, 34))).toBe("Studio Mac");
    expect([...bytes.subarray(34)].every((b) => b === 0)).toBe(true);
    expect(decodeBeacon(bytes)).toEqual({ version: 1, pairing: true, port: 8628, companion: h.companion, name: "Studio Mac" });
    // A long UTF-8 name is cut on a code point boundary inside its 40 bytes.
    const long = decodeBeacon(encodeBeacon({ pairing: false, port: 1, companion: h.companion, name: "的".repeat(20) }))!;
    expect(long.name).toBe("的".repeat(13));
    expect(decodeBeacon(new Uint8Array(64))).toBeNull();
  });

  test("preamble and frame header", () => {
    expect([...encodePreamble()]).toEqual([0x50, 0x4b, 0x4c, 0x4b, 1, 0, 0, 0]);
    const frame = encodeCtrl({ t: "catalog", id: 7 });
    expect(frame[0]).toBe(LINK_FRAME.ctrl);
    expect([...frame.subarray(1, 4)]).toEqual([0, 0, 0]);
    expect(new DataView(frame.buffer).getUint32(4, true)).toBe(frame.length - 8);
    const data = encodeData(0x01020304, new Uint8Array([9]));
    expect([...data]).toEqual([LINK_FRAME.data, 0, 0, 0, 5, 0, 0, 0, 4, 3, 2, 1, 9]);
  });

  test("the decoder reassembles split frames and guards the frame size", () => {
    const stream = new Uint8Array([
      ...encodePreamble(),
      ...encodeFrame(LINK_FRAME.ping),
      ...encodeCtrl({ t: "hello", v: 1 }),
      ...encodeFrame(0x7f, new Uint8Array(3)),
      ...encodeData(2, new Uint8Array(LINK_MAX_DATA).fill(1)),
    ]);
    let version = -1;
    const decoder = new LinkFrameDecoder({ preamble: true, onPreamble: (v) => (version = v) });
    const frames = [];
    for (let i = 0; i < stream.length; i += 997) frames.push(...decoder.push(stream.subarray(i, i + 997)));
    expect(version).toBe(1);
    expect(frames.map((f) => f.type)).toEqual(["ping", "ctrl", "unknown", "data"]);
    expect(frames[3].type === "data" && frames[3].bytes.length).toBe(LINK_MAX_DATA);

    const header = new Uint8Array(8);
    header[0] = LINK_FRAME.data;
    new DataView(header.buffer).setUint32(4, LINK_MAX_FRAME + 1, true);
    expect(() => new LinkFrameDecoder().push(header)).toThrow(LinkProtocolError);
    expect(() => new LinkFrameDecoder({ preamble: true }).push(new Uint8Array(8))).toThrow("bad preamble");
  });

  test("pairing URI", () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const uri = buildPairUri({ companion: h.companion, hosts: ["192.168.8.159", "10.0.0.2"], port: 8628, secret, name: "Evan's Mac" });
    expect(uri).toBe(`pocketlink://pair?v=1&c=${h.companion}&h=192.168.8.159,10.0.0.2&p=8628&s=${secret}&n=Evan%27s%20Mac`);
    expect(parsePairUri(uri)).toEqual({ version: 1, companion: h.companion, hosts: ["192.168.8.159", "10.0.0.2"], port: 8628, secret, name: "Evan's Mac" });
    const long = buildPairUri({ companion: h.companion, hosts: ["192.168.100.200", "192.168.101.201", "192.168.102.202", "1.1.1.1"], port: 65535, secret, name: "的".repeat(40) });
    expect(Buffer.byteLength(long)).toBeLessThan(LINK_PAIR_URI_MAX);
    const parsed = parsePairUri(long)!;
    expect(parsed.hosts.length).toBe(3);
    expect("的".repeat(40).startsWith(parsed.name)).toBe(true);
    expect(parsePairUri(uri.replace("v=1", "v=2"))).toBeNull();
    expect(parsePairUri(uri.replace("192.168.8.159", "example.com"))).toBeNull();
  });

  test("destination policy", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.8.1", "169.254.1.1", "100.64.0.1", "224.0.0.1", "0.0.0.0", "255.255.255.255", "::1", "fe80::1", "fd00::1", "ff02::1", "::ffff:192.168.1.1", "::"]) {
      expect(isPrivateAddress(a)).toBe(true);
    }
    for (const a of ["1.1.1.1", "104.20.23.154", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(a)).toBe(false);
  });

  test("fast FNV-1a64 matches the package reference", () => {
    for (const n of [0, 1, 255, 4099]) {
      const bytes = crypto.getRandomValues(new Uint8Array(n));
      expect(fnv1a64Hex(bytes)).toBe(fnv1a64(bytes).toString(16).padStart(16, "0"));
    }
  });
});

// ---------------------------------------------------------------------------
// Live link on loopback
// ---------------------------------------------------------------------------

function makePackage(options: { id: string; title: string; target?: string; version?: string; summary?: string; padBytes?: number }): Uint8Array {
  const manifest = new TextEncoder().encode(
    JSON.stringify({ pocket: 2, id: options.id, title: options.title, version: options.version ?? "1.0.0", ...(options.summary ? { summary: options.summary } : {}) }),
  );
  const output = options.id.split(".").at(-1)!;
  const pad = new Uint8Array(options.padBytes ?? 1000);
  for (let i = 0; i < pad.length; i++) pad[i] = (i * 31 + 7) & 255;
  return encodePocketPackage({
    manifest,
    variants: [
      {
        target: options.target ?? "3ds-dev",
        hostAbi: 11,
        sections: [
          { kind: POCKET_SECTION.identity, bytes: encodeIdentity({ output, id: options.id, title: options.title }) },
          { kind: POCKET_SECTION.js, bytes: new TextEncoder().encode("globalThis.x=1;\0") },
          { kind: POCKET_SECTION.pak, bytes: pad },
        ],
      },
    ],
  });
}

describe("link", () => {
  let companion: Companion;
  let store: CompanionStore;
  let appsDir: string;
  let web: ReturnType<typeof Bun.serve>;
  let base: string;
  let key = "";
  let hnPackage: Uint8Array;
  const logs: string[] = [];

  beforeAll(async () => {
    appsDir = freshDir("apps");
    hnPackage = makePackage({ id: "dev.pocket-nexus.hn", title: "Hacker News", version: "0.2.0", summary: "Top stories", padBytes: 200_000 });
    writeFileSync(join(appsDir, "hn.pocket"), hnPackage);
    writeFileSync(join(appsDir, "psp-only.pocket"), makePackage({ id: "dev.pocket-nexus.psp", title: "PSP", target: "psp" }));
    writeFileSync(join(appsDir, "broken.pocket"), new Uint8Array(100).fill(7));
    store = new CompanionStore(freshDir("store"));
    companion = new Companion({
      store,
      name: "Test Mac",
      port: 0,
      host: "127.0.0.1",
      appsDirs: [appsDir],
      allowPrivate: true,
      beacon: false,
      pairHosts: ["127.0.0.1"],
      log: (line) => logs.push(line),
    });
    await companion.start();

    let hops = 0;
    web = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/hello") return new Response("hello pocket", { headers: { "content-type": "text/plain", "x-test": "1" } });
        if (url.pathname === "/echo") {
          const body = await request.text();
          return Response.json({ method: request.method, body, auth: request.headers.get("x-app") });
        }
        const redirect = url.pathname.match(/^\/redirect\/(\d+)$/);
        if (redirect) {
          hops++;
          const n = Number(redirect[1]);
          return n === 0 ? new Response(`landed after ${hops}`) : Response.redirect(`${url.origin}/redirect/${n - 1}`, 302);
        }
        if (url.pathname === "/big") return new Response(new Uint8Array(100_000).fill(65));
        if (url.pathname === "/slow") {
          await Bun.sleep(1_000);
          return new Response("late");
        }
        return new Response("missing", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${web.port}`;
  });

  afterAll(async () => {
    await companion.stop();
    web.stop(true);
  });

  const pairOnce = async () => {
    const { uri } = companion.openPairing();
    const client = await LinkConsoleClient.pair(uri, DEVICE, { ping: false });
    return client;
  };

  test("pair: the console receives the key the companion stored", async () => {
    const client = await pairOnce();
    expect(client.companionName).toBe("Test Mac");
    expect(client.features).toEqual(["net", "catalog", "install"]);
    expect(client.key).toMatch(/^[0-9a-f]{64}$/);
    const stored = store.console(DEVICE.id)!;
    expect(stored.key).toBe(client.key);
    expect(stored).toMatchObject({ name: "Evan 3DS", model: "n3ds", lastAddress: "127.0.0.1" });
    expect(companion.pairingOpen()).toBe(false);
    key = client.key;
    client.close();
  });

  test("pair: a used secret is refused", async () => {
    const { uri } = companion.openPairing();
    (await LinkConsoleClient.pair(uri, { ...DEVICE, id: "1111111111111111" }, { ping: false })).close();
    const error = await LinkConsoleClient.pair(uri, { ...DEVICE, id: "2222222222222222" }, { ping: false }).catch((e) => e);
    expect(error).toBeInstanceOf(LinkRefused);
    expect(error.code).toBe(LINK_REFUSAL.pairingClosed);
    companion.forget("1111111111111111");
  });

  test("pair: an expired secret is refused", async () => {
    const short = new Companion({ store: new CompanionStore(freshDir("store")), name: "Short", port: 0, host: "127.0.0.1", beacon: false, pairHosts: ["127.0.0.1"], pairWindowMs: 40 });
    await short.start();
    try {
      const { uri } = short.openPairing();
      await Bun.sleep(80);
      const error = await LinkConsoleClient.pair(uri, DEVICE, { ping: false }).catch((e) => e);
      expect(error).toBeInstanceOf(LinkRefused);
      expect(error.code).toBe(LINK_REFUSAL.pairingClosed);
    } finally {
      await short.stop();
    }
  });

  test("pair: a wrong secret fails the console's check of the companion proof", async () => {
    const { uri } = companion.openPairing();
    const forged = uri.replace(/s=[0-9a-f]{32}/, `s=${"0".repeat(32)}`);
    const error = await LinkConsoleClient.pair(forged, { ...DEVICE, id: "3333333333333333" }, { ping: false }).catch((e) => e);
    expect(String(error.message)).toContain("companion proof did not verify");
    expect(store.console("3333333333333333")).toBeUndefined();
    companion.closePairing();
  });

  test("connect: the stored key links; a wrong key and an unknown device are refused", async () => {
    const opts = { host: "127.0.0.1", port: companion.port, device: DEVICE, companion: companion.id, ping: false };
    const client = await LinkConsoleClient.connect({ ...opts, key });
    expect(client.companionName).toBe("Test Mac");
    expect(companion.connected().map((c) => c.id)).toEqual([DEVICE.id]);
    client.close();

    // With a wrong key the console cannot verify the companion; drive the auth step raw to see the refusal.
    const wrong = await LinkConsoleClient.connect({ ...opts, key: "b".repeat(64) }).catch((e) => e);
    expect(String(wrong.message)).toContain("companion proof did not verify");
    const refusal = await rawAuthWithWrongProof(companion.port, companion.id);
    expect(refusal).toMatchObject({ t: "refused", code: LINK_REFUSAL.badProof });

    const unknown = await LinkConsoleClient.connect({ ...opts, device: { ...DEVICE, id: "4444444444444444" }, key }).catch((e) => e);
    expect(unknown).toBeInstanceOf(LinkRefused);
    expect(unknown.code).toBe(LINK_REFUSAL.unknownDevice);

    const version = await LinkConsoleClient.open({ ...opts, mode: "connect", secret: key, version: 2 }).catch((e) => e);
    expect(version).toBeInstanceOf(LinkRefused);
    expect(version.code).toBe(LINK_REFUSAL.version);
  });

  const linked = () => LinkConsoleClient.connect({ host: "127.0.0.1", port: companion.port, device: DEVICE, companion: companion.id, key, ping: false });

  test("net: GET, POST with a body, headers lowercased", async () => {
    const client = await linked();
    try {
      const hello = await client.net({ url: `${base}/hello`, headers: { "X-App": "hn" } }).done;
      expect(hello.status).toBe(200);
      expect(new TextDecoder().decode(hello.body)).toBe("hello pocket");
      expect(hello.headers["content-type"]).toBe("text/plain");
      expect(hello.headers["x-test"]).toBe("1");
      expect(Object.keys(hello.headers).every((k) => k === k.toLowerCase())).toBe(true);

      const body = new TextEncoder().encode("x".repeat(LINK_MAX_DATA + 10));
      const echo = await client.net({ url: `${base}/echo`, method: "POST", headers: { "X-App": "hn" }, body }).done;
      expect(JSON.parse(new TextDecoder().decode(echo.body))).toEqual({ method: "POST", body: "x".repeat(LINK_MAX_DATA + 10), auth: "hn" });

      const big = await client.net({ url: `${base}/big`, maxBytes: 128 * 1024 }).done;
      expect(big.body.length).toBe(100_000);
    } finally {
      client.close();
    }
  });

  test("net: redirects stop after three hops", async () => {
    const client = await linked();
    try {
      const three = await client.net({ url: `${base}/redirect/3` }).done;
      expect(three.url).toBe(`${base}/redirect/0`);
      expect(new TextDecoder().decode(three.body)).toStartWith("landed");
      const four = await client.net({ url: `${base}/redirect/4` }).done.catch((e) => e);
      expect(four).toBeInstanceOf(LinkNetError);
      expect(four.code).toBe(NET_ERROR.redirect);
    } finally {
      client.close();
    }
  });

  test("net: maxBytes, timeout, invalid requests, cancel", async () => {
    const client = await linked();
    try {
      const large = await client.net({ url: `${base}/big`, maxBytes: 1000 }).done.catch((e) => e);
      expect(large.code).toBe(NET_ERROR.responseTooLarge);
      const slow = await client.net({ url: `${base}/slow`, timeoutMs: 100 }).done.catch((e) => e);
      expect(slow.code).toBe(NET_ERROR.timeout);
      const ftp = await client.net({ url: "ftp://example.com/" }).done.catch((e) => e);
      expect(ftp.code).toBe(NET_ERROR.invalidRequest);
      const trace = await client.net({ url: `${base}/hello`, method: "TRACE" }).done.catch((e) => e);
      expect(trace.code).toBe(NET_ERROR.invalidRequest);
      const handle = client.net({ url: `${base}/slow` });
      client.cancelNet(handle.id);
      expect((await handle.done.catch((e) => e)).code).toBe("cancelled");
      // The link stays usable after all of these.
      expect((await client.net({ url: `${base}/hello` }).done).status).toBe(200);
    } finally {
      client.close();
    }
  });

  test("net: private destinations are refused unless allowed", async () => {
    const strict = new Companion({
      store,
      name: "Strict",
      port: 0,
      host: "127.0.0.1",
      beacon: false,
      resolve: async (host) => (host === "lan.example" ? ["192.168.1.10"] : ["93.184.215.14"]),
    });
    await strict.start();
    const client = await LinkConsoleClient.connect({ host: "127.0.0.1", port: strict.port, device: DEVICE, companion: strict.id, key, ping: false });
    try {
      for (const url of [`${base}/hello`, "http://lan.example/", "http://[::1]/", "http://169.254.169.254/latest"]) {
        const error = await client.net({ url }).done.catch((e) => e);
        expect(error).toBeInstanceOf(LinkNetError);
        expect(error.code).toBe(NET_ERROR.invalidRequest);
        expect(error.message).toContain("refuses local and private destinations");
      }
    } finally {
      client.close();
      await strict.stop();
    }
  });

  test("catalog and install stream a real package", async () => {
    const client = await linked();
    try {
      const apps = await client.catalog();
      const hash = fnv1a64(hnPackage.subarray(0, hnPackage.length - 8)).toString(16).padStart(16, "0");
      expect(apps).toEqual([
        { id: "dev.pocket-nexus.hn", title: "Hacker News", version: "0.2.0", output: "hn", hash, bytes: hnPackage.length, summary: "Top stories" },
      ]);
      const progress: number[] = [];
      const installed = await client.install("dev.pocket-nexus.hn", (received) => progress.push(received));
      expect(installed.hash).toBe(hash);
      expect(Buffer.from(installed.bytes).equals(Buffer.from(hnPackage))).toBe(true);
      expect(progress.length).toBe(Math.ceil(hnPackage.length / LINK_MAX_DATA));
      const missing = await client.install("dev.pocket-nexus.psp").catch((e) => e);
      expect(String(missing.message)).toContain("not offered for 3ds-dev");
    } finally {
      client.close();
    }
  });

  test("catalog.changed is pushed when the apps directory changes", async () => {
    const client = await linked();
    try {
      const changed = new Promise<void>((resolve) => client.onMessage((m) => m.t === "catalog.changed" && resolve()));
      writeFileSync(join(appsDir, "clock.pocket"), makePackage({ id: "dev.pocket-nexus.clock", title: "Clock" }));
      await Promise.race([changed, Bun.sleep(4_000).then(() => Promise.reject(new Error("no catalog.changed")))]);
      expect((await client.catalog()).map((a) => a.id)).toEqual(["dev.pocket-nexus.clock", "dev.pocket-nexus.hn"]);
    } finally {
      client.close();
    }
  });

  test("a frame longer than LINK_MAX_FRAME closes the connection", async () => {
    const client = await linked();
    const closed = new Promise<string>((resolve) => client.onClose(resolve));
    const header = new Uint8Array(8);
    header[0] = LINK_FRAME.data;
    new DataView(header.buffer).setUint32(4, LINK_MAX_FRAME + 1, true);
    client.writeRaw(header);
    expect(await Promise.race([closed, Bun.sleep(2_000).then(() => "still open")])).not.toBe("still open");
    expect(logs.some((l) => l.includes(`exceeds ${LINK_MAX_FRAME}`))).toBe(true);
  });

  test("control API: status, pair, forget", async () => {
    const dir = freshDir("control");
    const control = startControl(companion, dir);
    try {
      const info = readControl(dir)!;
      expect(info).toEqual(control.info);
      expect((readFileSync(join(dir, "control.json")).length > 0)).toBe(true);
      const denied = await fetch(`http://127.0.0.1:${info.port}/status`);
      expect(denied.status).toBe(401);

      const client = await linked();
      const status = await controlRequest<ReturnType<Companion["status"]>>(info, "GET", "/status");
      expect(status.companion).toMatchObject({ id: companion.id, name: "Test Mac", port: companion.port });
      expect(status.consoles.map((c) => c.id)).toEqual([DEVICE.id]);
      expect(status.paired.map((p) => p.id)).toContain(DEVICE.id);
      expect(JSON.stringify(status)).not.toContain(key);
      expect(status.apps.length).toBe(2);

      const window = await controlRequest<{ uri: string; expiresAt: number }>(info, "POST", "/pair");
      expect(parsePairUri(window.uri)?.companion).toBe(companion.id);
      expect((await controlRequest<ReturnType<Companion["status"]>>(info, "GET", "/status")).pairing.open).toBe(true);
      await controlRequest(info, "DELETE", "/pair");

      const closed = new Promise<string>((resolve) => client.onClose(resolve));
      expect(await controlRequest<{ removed: boolean }>(info, "DELETE", `/consoles/${DEVICE.id}`)).toEqual({ removed: true });
      await closed;
      expect(store.console(DEVICE.id)).toBeUndefined();
      const again = await linked().catch((e) => e);
      expect(again.code).toBe(LINK_REFUSAL.unknownDevice);
    } finally {
      control.stop();
    }
    expect(readControl(dir)).toBeNull();
  });
});

/** Hello with a valid shape, then an auth proof that cannot verify. */
async function rawAuthWithWrongProof(port: number, companionId: string): Promise<Record<string, unknown>> {
  const socket = connect({ host: "127.0.0.1", port });
  const decoder = new LinkFrameDecoder();
  const messages: Record<string, unknown>[] = [];
  return new Promise((resolve, reject) => {
    socket.on("data", (chunk) => {
      for (const frame of decoder.push(new Uint8Array(chunk as Buffer))) {
        if (frame.type !== "ctrl") continue;
        messages.push(frame.message);
        if (frame.message.t === "challenge") socket.write(encodeCtrl({ t: "auth", proof: "0".repeat(64) }));
        if (frame.message.t === "refused") resolve(frame.message);
      }
    });
    socket.on("close", () => reject(new Error(`closed after ${JSON.stringify(messages)}`)));
    socket.write(encodePreamble());
    socket.write(encodeCtrl({ t: "hello", v: 1, mode: "connect", device: DEVICE.id, companion: companionId, nonce: "ab".repeat(16), name: "raw", model: "n3ds", target: "3ds-dev" }));
  }).finally(() => socket.destroy()) as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Beacon
// ---------------------------------------------------------------------------

test("beacons reach a console's last address with the pairing flag", async () => {
  const seen: { pairing: boolean; port: number; companion: string; address: string }[] = [];
  const listener = await listenBeacons((beacon, address) => seen.push({ ...beacon, address }), 0);
  const companion = new Companion({
    store: new CompanionStore(freshDir("store")),
    name: "Beacon Mac",
    port: 0,
    host: "127.0.0.1",
    beacon: { port: listener.port, intervalMs: 50, broadcast: false },
    unicast: ["127.0.0.1"],
    pairHosts: ["127.0.0.1"],
  });
  try {
    await companion.start();
    await Bun.sleep(120);
    companion.openPairing();
    await Bun.sleep(120);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen[0]).toMatchObject({ pairing: false, port: companion.port, companion: companion.id, name: "Beacon Mac", address: "127.0.0.1" });
    expect(seen.at(-1)!.pairing).toBe(true);
  } finally {
    listener.close();
    await companion.stop();
  }
});

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------

// ISO/IEC 18004 level-M block table and the published BCH words, typed out
// independently of tools/companion/qr.ts.
const M_TABLE: Record<number, { ec: number; blocks: number[] }> = {
  1: { ec: 10, blocks: [16] },
  2: { ec: 16, blocks: [28] },
  3: { ec: 26, blocks: [44] },
  4: { ec: 18, blocks: [32, 32] },
  5: { ec: 24, blocks: [43, 43] },
  6: { ec: 16, blocks: [27, 27, 27, 27] },
  7: { ec: 18, blocks: [31, 31, 31, 31] },
  8: { ec: 22, blocks: [38, 38, 39, 39] },
  9: { ec: 22, blocks: [36, 36, 36, 37, 37] },
  10: { ec: 26, blocks: [43, 43, 43, 43, 44] },
};
const FORMAT_M = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
const VERSION_INFO: Record<number, number> = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3 };

const GF_EXP = new Array<number>(512);
const GF_LOG = new Array<number>(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}
const gfMul = (a: number, b: number) => (a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0);

/** Read a code back: format word, version word, unmask, de-interleave, RS
 *  syndromes, byte-mode payload. */
function readQr(qr: QrCode): string {
  const m = qr.modules;
  const size = qr.size;
  let format = 0;
  const fmt = [...Array(6).keys()].map((i) => [8, i]).concat([[8, 7], [8, 8], [7, 8]], [9, 10, 11, 12, 13, 14].map((i) => [14 - i, 8]));
  fmt.forEach(([x, y], i) => (format |= (m[y][x] ? 1 : 0) << i));
  const mask = FORMAT_M.indexOf(format);
  if (mask < 0) throw new Error(`format word ${format.toString(16)} is not level M`);
  if (qr.version >= 7) {
    let word = 0;
    for (let i = 0; i < 18; i++) word |= (m[Math.floor(i / 3)][size - 11 + (i % 3)] ? 1 : 0) << i;
    if (word !== VERSION_INFO[qr.version]) throw new Error("version word");
  }
  const fn = functionModules(qr.version);
  const MASKS = [
    (x: number, y: number) => (x + y) % 2 === 0,
    (_x: number, y: number) => y % 2 === 0,
    (x: number) => x % 3 === 0,
    (x: number, y: number) => (x + y) % 3 === 0,
    (x: number, y: number) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x: number, y: number) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x: number, y: number) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x: number, y: number) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fn[y][x]) bits.push((m[y][x] !== MASKS[mask](x, y)) ? 1 : 0);
      }
    }
  }
  const { ec, blocks } = M_TABLE[qr.version];
  const total = blocks.reduce((a, b) => a + b, 0) + ec * blocks.length;
  const codewords: number[] = [];
  for (let i = 0; i < total; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((n, b) => (n << 1) | b, 0));
  const split = blocks.map(() => [] as number[]);
  let k = 0;
  for (let i = 0; i < Math.max(...blocks); i++) blocks.forEach((len, b) => i < len && split[b].push(codewords[k++]));
  for (let i = 0; i < ec; i++) blocks.forEach((_len, b) => split[b].push(codewords[k++]));
  const data: number[] = [];
  split.forEach((block, b) => {
    for (let s = 0; s < ec; s++) {
      let acc = 0;
      for (const c of block) acc = gfMul(acc, GF_EXP[s]) ^ c;
      if (acc !== 0) throw new Error(`block ${b} syndrome ${s} = ${acc}`);
    }
    data.push(...block.slice(0, blocks[b]));
  });
  const stream = data.flatMap((byte) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (byte >> i) & 1));
  const read = (at: number, n: number) => stream.slice(at, at + n).reduce((v, b) => (v << 1) | b, 0);
  if (read(0, 4) !== 0b0100) throw new Error("not byte mode");
  const countBits = qr.version <= 9 ? 8 : 16;
  const count = read(4, countBits);
  const bytes = Uint8Array.from({ length: count }, (_, i) => read(4 + countBits + i * 8, 8));
  return new TextDecoder().decode(bytes);
}

describe("qr", () => {
  const cases: string[] = [];
  for (let v = 1; v <= 10; v++) {
    const cap = byteCapacity(v);
    cases.push("p".repeat(cap));
  }
  cases.push(buildPairUri({ companion: "fedcba9876543210", hosts: ["192.168.8.159"], port: 8628, secret: "0123456789abcdef0123456789abcdef", name: "evan的MacBook Pro" }));

  test("capacities match level M byte mode", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(byteCapacity)).toEqual([14, 26, 42, 62, 84, 106, 122, 152, 180, 213]);
    expect(encodeQr("x".repeat(14)).version).toBe(1);
    expect(encodeQr("x".repeat(15)).version).toBe(2);
    expect(() => encodeQr("x".repeat(214))).toThrow();
  });

  test("every version and mask reads back with zero syndromes", () => {
    for (const [i, text] of cases.entries()) {
      for (let mask = 0; mask < 8; mask++) {
        const qr = encodeQr(text, { mask });
        expect(qr.version).toBe(i < 10 ? i + 1 : qr.version);
        expect(readQr(qr)).toBe(text);
      }
      expect(readQr(encodeQr(text))).toBe(text);
    }
  });

  const swiftc = process.platform === "darwin" ? Bun.which("swiftc") : null;
  test.skipIf(!swiftc)("CoreImage's detector decodes the codes (macOS)", () => {
    const dir = freshDir("qr");
    const decoder = join(dir, "qrdecode");
    writeFileSync(
      join(dir, "qrdecode.swift"),
      `import CoreImage
import Foundation
let detector = CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])!
for path in CommandLine.arguments.dropFirst() {
  let image = CIImage(contentsOf: URL(fileURLWithPath: path))!
  let text = detector.features(in: image).compactMap { $0 as? CIQRCodeFeature }.first?.messageString ?? ""
  print(Data(text.utf8).base64EncodedString())
}
`,
    );
    const build = spawnSync(swiftc!, ["-O", join(dir, "qrdecode.swift"), "-o", decoder], { encoding: "utf8" });
    expect(build.status).toBe(0);
    const files = cases.map((text, i) => {
      const { width, pixels } = rasterizeQr(encodeQr(text), 6);
      const rgba = new Uint8Array(width * width * 4);
      for (let p = 0; p < pixels.length; p++) rgba.fill(pixels[p], p * 4, p * 4 + 3), (rgba[p * 4 + 3] = 255);
      const file = join(dir, `${i}.png`);
      writeFileSync(file, encodePNG(rgba, width, width));
      return file;
    });
    const run = spawnSync(decoder, files, { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n").map((line) => Buffer.from(line, "base64").toString())).toEqual(cases);
  });
});
