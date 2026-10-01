import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSocket } from "node:dgram";
import { createServer, type Socket } from "node:net";
import {
  POCKET_RUNTIME_ACK_BYTES,
  POCKET_RUNTIME_DISCOVERY_MAGIC,
  POCKET_RUNTIME_DISCOVERY_REPLY,
  POCKET_RUNTIME_DISCOVERY_REPLY_BYTES,
  POCKET_RUNTIME_FRAME_HEADER_BYTES,
  POCKET_RUNTIME_MAX_FRAME_BYTES,
  POCKET_RUNTIME_MAX_CTRL_BYTES,
  POCKET_RUNTIME_MSG,
  POCKET_RUNTIME_NATIVE_BEGIN_BYTES,
  POCKET_RUNTIME_NATIVE_FLAG_LAUNCH,
  POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8,
  POCKET_RUNTIME_TOKEN_BYTES,
  POCKET_RUNTIME_WIRE_MAGIC,
  PocketRuntimeFrameDecoder,
  decodePocketRuntimeAck,
  decodePocketRuntimeDiscoveryReply,
  decodePocketRuntimeScreenshotBegin,
  encodePocketRuntimeFrame,
  encodePocketRuntimeHello,
  encodePocketRuntimeLaunch,
  encodePocketRuntimeNativeBegin,
  encodePocketRuntimeChunk,
  encodePocketRuntimePackageBegin,
  pocketPackageFooterHash,
  pocketRuntimeCrc32,
  pocketRuntimeDeviceId,
  pocketRuntimeNativeNameValid,
} from "../contracts/spec/pocket-runtime-wire.ts";
import {
  PocketRuntimeClient,
  PocketRuntimeSession,
  combinePocketRuntimeScreens,
  decodePocketRuntimeSurface,
  discoverPocketRuntimes,
} from "../tools/3ds-runtime-client.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Nintendo 3DS Pocket Runtime wire", () => {
  test("keeps TypeScript and C protocol constants byte-exact", async () => {
    const header = readFileSync(join(ROOT, "hosts/3ds/src/dev_protocol.h"), "utf8");
    // Every numeric #define, evaluated with its references to other defines.
    const expressions = new Map(
      [...header.matchAll(/^#define (POCKET_RUNTIME_\w+) (.+?)(?:\s*\/\*.*)?$/gm)].map((m) => [m[1], m[2]]),
    );
    const value = (name: string): number => {
      const text = expressions.get(name)!
        .replace(/\b(0x[0-9a-f]+|\d+)u\b/gi, "$1")
        .replace(/\bPOCKET_RUNTIME_\w+/g, (reference) => String(value(reference)));
      return Function(`return (${text});`)() as number;
    };
    const wire = await import("../contracts/spec/pocket-runtime-wire.ts");
    const mirrored = Object.entries(wire).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && expressions.has(entry[0]),
    );
    expect(mirrored.length).toBeGreaterThan(15);
    for (const [name, exported] of mirrored) expect([name, value(name)]).toEqual([name, exported]);
    // Every message id, named the way the C enum spells it.
    for (const [key, id] of Object.entries(POCKET_RUNTIME_MSG)) {
      const name = key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
      expect(header).toContain(`POCKET_RUNTIME_MSG_${name} = 0x${id.toString(16).padStart(2, "0")},`);
    }
    expect(POCKET_RUNTIME_WIRE_MAGIC).toBe(0x54524b50);
    expect(POCKET_RUNTIME_TOKEN_BYTES).toBe(32);
    expect(POCKET_RUNTIME_MAX_CTRL_BYTES).toBe(16 * 1024);
  });

  test("identifies paired devices without exposing their token", () => {
    const token = Uint8Array.from({ length: 32 }, (_, index) => index);
    expect(pocketRuntimeDeviceId(token)).toBe(0xe6cb594c1a148ac5n);
    const reply = new Uint8Array(POCKET_RUNTIME_DISCOVERY_REPLY_BYTES);
    const data = new DataView(reply.buffer);
    data.setUint32(0, POCKET_RUNTIME_DISCOVERY_MAGIC, true);
    data.setUint8(4, 1);
    data.setUint8(5, POCKET_RUNTIME_DISCOVERY_REPLY);
    data.setUint16(6, 8, true);
    data.setUint16(8, 8131, true);
    data.setUint16(10, 1, true);
    data.setUint32(12, 3, true);
    data.setBigUint64(16, 0xe01adc15327d4203n, true);
    data.setBigUint64(24, pocketRuntimeDeviceId(token), true);
    reply.set(new TextEncoder().encode("3ds-dev"), 32);
    reply.set(new TextEncoder().encode("PocketJS 3DS"), 48);
    expect(decodePocketRuntimeDiscoveryReply(reply)).toEqual({
      hostAbi: 8,
      port: 8131,
      flags: 1,
      generation: 3,
      activeHash: 0xe01adc15327d4203n,
      deviceId: 0xe6cb594c1a148ac5n,
      target: "3ds-dev",
      label: "PocketJS 3DS",
    });
  });

  test("discovers a Runtime over one UDP request/reply", async () => {
    const server = createSocket("udp4");
    const reply = new Uint8Array(POCKET_RUNTIME_DISCOVERY_REPLY_BYTES);
    const data = new DataView(reply.buffer);
    data.setUint32(0, POCKET_RUNTIME_DISCOVERY_MAGIC, true);
    data.setUint8(4, 1);
    data.setUint8(5, POCKET_RUNTIME_DISCOVERY_REPLY);
    data.setUint16(6, 8, true);
    data.setUint16(8, 8131, true);
    data.setUint32(12, 9, true);
    data.setBigUint64(24, 0x1234n, true);
    reply.set(new TextEncoder().encode("3ds-dev"), 32);
    reply.set(new TextEncoder().encode("PocketJS 3DS"), 48);
    server.on("message", (request, remote) => {
      expect(new DataView(request.buffer, request.byteOffset).getUint32(0, true)).toBe(
        POCKET_RUNTIME_DISCOVERY_MAGIC,
      );
      server.send(reply, remote.port, remote.address);
    });
    await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string") throw new Error("UDP fixture has no port");
    try {
      const devices = await discoverPocketRuntimes({
        port: address.port,
        addresses: ["127.0.0.1"],
        timeoutMs: 50,
      });
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({
        address: "127.0.0.1",
        port: 8131,
        generation: 9,
        deviceId: 0x1234n,
        target: "3ds-dev",
      });
    } finally {
      server.close();
    }
  });

  test("authenticates an exact 32-byte pairing token and decodes the ack", () => {
    const token = Uint8Array.from({ length: 32 }, (_, index) => index);
    const hello = encodePocketRuntimeHello(token);
    expect(hello.length).toBe(40);
    expect([...hello.slice(8)]).toEqual([...token]);

    const ack = new Uint8Array(POCKET_RUNTIME_ACK_BYTES);
    const view = new DataView(ack.buffer);
    view.setUint32(0, POCKET_RUNTIME_WIRE_MAGIC, true);
    view.setUint8(4, 1);
    view.setUint16(6, 8, true);
    view.setUint32(8, 7, true);
    view.setUint32(12, 1, true);
    view.setBigUint64(16, 0xe01adc15327d4203n, true);
    expect(decodePocketRuntimeAck(ack)).toEqual({
      accepted: true,
      status: 0,
      hostAbi: 8,
      generation: 7,
      flags: 1,
      activeHash: 0xe01adc15327d4203n,
    });
  });

  test("incrementally decodes ordered control and binary frames", () => {
    const control = encodePocketRuntimeFrame(
      POCKET_RUNTIME_MSG.ctrl,
      new TextEncoder().encode('{"t":"getTree"}'),
    );
    const begin = encodePocketRuntimeFrame(
      POCKET_RUNTIME_MSG.packageBegin,
      encodePocketRuntimePackageBegin(390200, 0xe01adc15327d4203n),
    );
    const bytes = new Uint8Array(control.length + begin.length);
    bytes.set(control);
    bytes.set(begin, control.length);
    const decoder = new PocketRuntimeFrameDecoder();
    expect(decoder.push(bytes.slice(0, 3))).toEqual([]);
    expect(decoder.push(bytes.slice(3, control.length + 2))).toHaveLength(1);
    const frames = decoder.push(bytes.slice(control.length + 2));
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(POCKET_RUNTIME_MSG.packageBegin);
    expect(decoder.pendingBytes).toBe(0);

    const tooLarge = new Uint8Array(POCKET_RUNTIME_FRAME_HEADER_BYTES);
    new DataView(tooLarge.buffer).setUint32(4, POCKET_RUNTIME_MAX_FRAME_BYTES + 1, true);
    expect(() => new PocketRuntimeFrameDecoder().push(tooLarge)).toThrow("advertises");
    const reserved = new Uint8Array(POCKET_RUNTIME_FRAME_HEADER_BYTES);
    reserved[2] = 1;
    expect(() => new PocketRuntimeFrameDecoder().push(reserved)).toThrow("reserved");
  });

  test("package chunks carry an absolute offset before bulk bytes", () => {
    const payload = encodePocketRuntimeChunk(0x12345678, Uint8Array.of(1, 2, 3));
    expect(new DataView(payload.buffer).getUint32(0, true)).toBe(0x12345678);
    expect([...payload.slice(4)]).toEqual([1, 2, 3]);
  });

  test(".3dsx transfers name one file under sdmc:/3ds and carry zlib's CRC-32", () => {
    expect(pocketRuntimeCrc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    for (const name of ["pocketshell-main.3dsx", "Pocket_Nexus.3DSX"]) {
      expect(pocketRuntimeNativeNameValid(name)).toBe(true);
    }
    for (const name of [".3dsx", ".hidden.3dsx", "../boot.3dsx", "dir/app.3dsx", "app.cia", "app 1.3dsx"]) {
      expect(pocketRuntimeNativeNameValid(name)).toBe(false);
    }
    // The same frame tests/fixtures/3ds-native-install.c parses.
    const begin = encodePocketRuntimeNativeBegin(
      2810384,
      0xafe26828,
      "pocketshell-main.3dsx",
      POCKET_RUNTIME_NATIVE_FLAG_LAUNCH,
    );
    expect(begin.length).toBe(POCKET_RUNTIME_NATIVE_BEGIN_BYTES);
    const data = new DataView(begin.buffer);
    expect(data.getUint32(0, true)).toBe(2810384);
    expect(data.getUint32(4, true)).toBe(0xafe26828);
    expect([begin[8], begin[9], begin[10], begin[11]]).toEqual([1, 21, 0, 0]);
    expect(new TextDecoder().decode(begin.subarray(12, 33))).toBe("pocketshell-main.3dsx");
    expect(begin.subarray(33).every((byte) => byte === 0)).toBe(true);
    expect(() => encodePocketRuntimeNativeBegin(64, 0, "boot.cia")).toThrow("file name");
    expect(() => encodePocketRuntimeNativeBegin(31, 0, "short.3dsx")).toThrow("32 bytes");
    const launch = encodePocketRuntimeLaunch("nexus.3dsx");
    expect([launch[0], launch[1], launch[2], launch[3]]).toEqual([10, 0, 0, 0]);
    expect(new TextDecoder().decode(launch.subarray(4, 14))).toBe("nexus.3dsx");
  });

  test("decodes rotated BGR surfaces and combines both screens into PNG", () => {
    const top = Uint8Array.of(3, 2, 1, 6, 5, 4); // two vertical BGR pixels
    expect([...decodePocketRuntimeSurface(top, 1, 2)]).toEqual([
      4, 5, 6, 255,
      1, 2, 3, 255,
    ]);
    const begin = new Uint8Array(24);
    const data = new DataView(begin.buffer);
    data.setUint32(0, 12, true);
    data.setUint16(4, 1, true);
    data.setUint16(6, 2, true);
    data.setUint16(8, 1, true);
    data.setUint16(10, 1, true);
    data.setUint8(12, POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8);
    data.setUint32(16, 6, true);
    data.setUint32(20, 3, true);
    const metadata = decodePocketRuntimeScreenshotBegin(begin);
    const png = combinePocketRuntimeScreens(metadata, top, Uint8Array.of(9, 8, 7));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
  });

  test("the host C implementation accepts the same transcript", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-3ds-dev-protocol-"));
    temporary.push(directory);
    const binary = join(directory, "protocol-test");
    const compiler = Bun.which("cc");
    expect(compiler).not.toBeNull();
    const compile = Bun.spawnSync([
      compiler!,
      "-std=c11",
      `-I${join(ROOT, "hosts/3ds/src")}`,
      join(ROOT, "tests/fixtures/3ds-dev-protocol.c"),
      join(ROOT, "hosts/3ds/src/dev_protocol.c"),
      "-o",
      binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  });

  test("the native menu emits one bounded rectangle-only DrawList", () => {
    const directory = mkdtempSync(join(tmpdir(), "pocketjs-3ds-devmenu-"));
    temporary.push(directory);
    const binary = join(directory, "devmenu-test");
    const compiler = Bun.which("cc");
    expect(compiler).not.toBeNull();
    const compile = Bun.spawnSync([
      compiler!,
      "-std=c11",
      '-DPOCKETJS_RUNTIME_SLOT="0123456789abcdef"',
      `-I${join(ROOT, "hosts/3ds/src")}`,
      `-I${join(ROOT, "hosts/3ds/include")}`,
      join(ROOT, "tests/fixtures/3ds-devmenu.c"),
      join(ROOT, "hosts/3ds/src/devmenu.c"),
      "-o",
      binary,
    ]);
    expect(compile.exitCode, compile.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  });

  test("the client survives fragmented handshake, uploads, control, and screenshot frames", async () => {
    const token = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
    const connection: { peer: Socket | null } = { peer: null };
    let incoming = new Uint8Array(0);
    let authenticated = false;
    const decoder = new PocketRuntimeFrameDecoder();
    const uploaded: Uint8Array[] = [];
    const native: { begin: DataView | null; chunks: Uint8Array[]; aborted: boolean } = {
      begin: null,
      chunks: [],
      aborted: false,
    };
    const nativeName = () => native.begin
      ? new TextDecoder().decode(new Uint8Array(native.begin.buffer, 12, native.begin.getUint8(9)))
      : "";
    const receipt = (phase: string, message = "") => Buffer.from(encodePocketRuntimeFrame(
      POCKET_RUNTIME_MSG.ctrl,
      new TextEncoder().encode(JSON.stringify({
        t: "runtime.native", phase, name: nativeName(), path: `sdmc:/3ds/${nativeName()}`, message,
      })),
    ));
    const server = createServer((socket) => {
      connection.peer = socket;
      socket.on("data", (chunk: Buffer) => {
        const joined = new Uint8Array(incoming.length + chunk.length);
        joined.set(incoming);
        joined.set(chunk, incoming.length);
        incoming = joined;
        if (!authenticated) {
          if (incoming.length < 40) return;
          expect([...incoming.slice(8, 40)]).toEqual([...token]);
          incoming = incoming.slice(40);
          authenticated = true;
          const ack = new Uint8Array(POCKET_RUNTIME_ACK_BYTES);
          const data = new DataView(ack.buffer);
          data.setUint32(0, POCKET_RUNTIME_WIRE_MAGIC, true);
          data.setUint8(4, 1);
          data.setUint16(6, 8, true);
          socket.write(ack.slice(0, 5));
          setTimeout(() => socket.write(ack.slice(5)), 5);
        }
        for (const frame of decoder.push(incoming)) {
          incoming = new Uint8Array(0);
          if (frame.type === POCKET_RUNTIME_MSG.packageChunk) uploaded.push(frame.payload.slice(4));
          if (frame.type === POCKET_RUNTIME_MSG.nativeBegin) {
            native.begin = new DataView(frame.payload.buffer);
            native.chunks = [];
          }
          if (frame.type === POCKET_RUNTIME_MSG.nativeChunk) {
            expect(new DataView(frame.payload.buffer).getUint32(0, true)).toBe(
              native.chunks.reduce((sum, bytes) => sum + bytes.length, 0),
            );
            native.chunks.push(frame.payload.slice(4));
          }
          if (frame.type === POCKET_RUNTIME_MSG.nativeAbort) native.aborted = true;
          if (frame.type === POCKET_RUNTIME_MSG.nativeCommit && native.begin) {
            const file = Buffer.concat(native.chunks.map((bytes) => Buffer.from(bytes)));
            expect(file.length).toBe(native.begin.getUint32(0, true));
            expect(pocketRuntimeCrc32(file)).toBe(native.begin.getUint32(4, true));
            const replies = [receipt("installed")];
            if (native.begin.getUint8(8) & POCKET_RUNTIME_NATIVE_FLAG_LAUNCH) replies.push(receipt("launching"));
            socket.write(Buffer.concat(replies));
          }
          if (frame.type === POCKET_RUNTIME_MSG.packageCommit) {
            const packageBytes = Buffer.concat(uploaded.map((bytes) => Buffer.from(bytes)));
            const hash = pocketPackageFooterHash(packageBytes).toString(16).padStart(16, "0");
            const line = new TextEncoder().encode(
              JSON.stringify({ t: "runtime.install", phase: "accepted", hash }),
            );
            socket.write(encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.ctrl, line));
          }
          if (frame.type === POCKET_RUNTIME_MSG.ctrl) {
            const command = JSON.parse(new TextDecoder().decode(frame.payload));
            if (command.t !== "screenshot") continue;
            const begin = new Uint8Array(24);
            const data = new DataView(begin.buffer);
            data.setUint32(0, 77, true);
            data.setUint16(4, 1, true);
            data.setUint16(6, 2, true);
            data.setUint16(8, 1, true);
            data.setUint16(10, 1, true);
            data.setUint8(12, POCKET_RUNTIME_SCREENSHOT_FORMAT_ROTATED_RGB8);
            data.setUint32(16, 6, true);
            data.setUint32(20, 3, true);
            const top = Uint8Array.of(0, 0, 255, 0, 255, 0);
            const auxiliary = Uint8Array.of(255, 0, 0);
            const chunk = (offset: number, bytes: Uint8Array) => {
              const payload = new Uint8Array(4 + bytes.length);
              new DataView(payload.buffer).setUint32(0, offset, true);
              payload.set(bytes, 4);
              return payload;
            };
            const end = new Uint8Array(4);
            new DataView(end.buffer).setUint32(0, 77, true);
            socket.write(Buffer.concat([
              encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.screenshotBegin, begin),
              encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.screenshotChunk, chunk(0, top), 0),
              encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.screenshotChunk, chunk(0, auxiliary), 1),
              encodePocketRuntimeFrame(POCKET_RUNTIME_MSG.screenshotEnd, end),
            ].map((bytes) => Buffer.from(bytes))));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    const client = new PocketRuntimeClient({
      host: "127.0.0.1",
      port: address.port,
      token,
      timeoutMs: 2_000,
    });
    try {
      await client.connect();
      const packageBytes = new Uint8Array(70_000);
      new DataView(packageBytes.buffer).setBigUint64(
        packageBytes.length - 8,
        0x0102030405060708n,
        true,
      );
      const accepted = client.waitForCtrl(
        (message) => message.t === "runtime.install" && message.phase === "accepted",
      );
      await client.install(packageBytes);
      expect((await accepted).hash).toBe("0102030405060708");
      const executable = Uint8Array.from({ length: 150_000 }, (_, index) => (index * 7) & 0xff);
      executable.set(new TextEncoder().encode("3DSX"));
      const installed = client.waitForCtrl((message) => message.t === "runtime.native" && message.phase === "installed");
      const launching = client.waitForCtrl((message) => message.t === "runtime.native" && message.phase === "launching");
      await client.installNative(executable, "app.3dsx", true);
      expect((await installed).path).toBe("sdmc:/3ds/app.3dsx");
      expect((await launching).name).toBe("app.3dsx");
      expect(native.chunks.length).toBe(3);
      // Once the caller reports a device-side failure the stream stops: the
      // rest is not sent and the transfer is aborted, never committed.
      const large = new Uint8Array(1_000_000);
      large.set(new TextEncoder().encode("3DSX"));
      let polls = 0;
      await client.installNative(large, "full.3dsx", false, () => ++polls > 2);
      await client.requestStatus(); // a frame after the abort, so the server has read it
      await Bun.sleep(20);
      expect(native.aborted).toBe(true);
      expect(native.chunks.length).toBe(2);
      const screenshot = client.waitForScreenshot();
      await client.sendCtrl({ t: "screenshot" });
      const image = await screenshot;
      expect(image.frame).toBe(77);
      expect(image.png.subarray(1, 4).toString()).toBe("PNG");
    } finally {
      client.close();
      connection.peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a persistent session replaces a disconnected TCP client", async () => {
    const token = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const peers: Socket[] = [];
    const server = createServer((socket) => {
      peers.push(socket);
      let hello = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        if (hello.length >= 40) return;
        hello = Buffer.concat([hello, chunk]);
        if (hello.length < 40) return;
        const ack = new Uint8Array(POCKET_RUNTIME_ACK_BYTES);
        const data = new DataView(ack.buffer);
        data.setUint32(0, POCKET_RUNTIME_WIRE_MAGIC, true);
        data.setUint8(4, 1);
        data.setUint16(6, 8, true);
        data.setUint32(8, peers.length, true);
        socket.write(ack);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    const session = new PocketRuntimeSession({
      retryDelayMs: 10,
      createClient: () => new PocketRuntimeClient({
        host: "127.0.0.1",
        port: address.port,
        token,
        timeoutMs: 500,
      }),
    });
    try {
      await session.start();
      expect(session.connected).toBe(true);
      const reconnected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("session did not reconnect")), 2_000);
        session.once("reconnect", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      peers[0].destroy();
      await reconnected;
      expect(session.connected).toBe(true);
      expect(peers).toHaveLength(2);
    } finally {
      session.close();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a persistent session replaces a half-open client that stops answering pings", async () => {
    const token = Uint8Array.from({ length: 32 }, (_, index) => 32 - index);
    const peers: Socket[] = [];
    const server = createServer((socket) => {
      peers.push(socket);
      let hello = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        if (hello.length >= 40) return;
        hello = Buffer.concat([hello, chunk]);
        if (hello.length < 40) return;
        const ack = new Uint8Array(POCKET_RUNTIME_ACK_BYTES);
        const data = new DataView(ack.buffer);
        data.setUint32(0, POCKET_RUNTIME_WIRE_MAGIC, true);
        data.setUint8(4, 1);
        data.setUint16(6, 8, true);
        socket.write(ack);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no TCP port");
    const session = new PocketRuntimeSession({
      retryDelayMs: 5,
      createClient: () => new PocketRuntimeClient({
        host: "127.0.0.1",
        port: address.port,
        token,
        timeoutMs: 500,
        heartbeatIntervalMs: 10,
        heartbeatTimeoutMs: 30,
      }),
    });
    try {
      await session.start();
      const reconnected = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("half-open session did not reconnect")), 500);
        session.once("reconnect", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await reconnected;
      expect(session.connected).toBe(true);
      expect(peers).toHaveLength(2);
    } finally {
      session.close();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
