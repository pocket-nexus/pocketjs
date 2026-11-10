// `globalThis.link.channel` as a QuickJS guest reaches it: the bindings of
// engine/host-services/link2_channel_qjs.c in a real QuickJS under ASan and
// UBSan, with the client's channel calls stubbed
// (tests/fixtures/link2-channel-qjs-harness.c). What is checked: no call uses a
// buffer the guest freed while its arguments were converted, a handle of an
// earlier generation reaches nothing, one side of an id closes without the
// other, and no call leaks or leaves an exception pending.

import { lockedQuickJsSources, quickJsVendorObjects } from "../tools/quickjs-vendor.ts";
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const scratch = join(root, `.pocket-build/validation/link2-channel-qjs/${Date.now()}-${process.pid}`);
const SANITIZE = ["-fsanitize=address,undefined", "-fno-sanitize-recover=undefined", "-fno-omit-frame-pointer"];
let binary = "";
let serial = 0;

beforeAll(() => {
  mkdirSync(scratch, { recursive: true });
  const cc = Bun.which("cc");
  expect(cc).not.toBeNull();
  const quickjs = lockedQuickJsSources();
  const vendor = quickJsVendorObjects({
    cc: cc!, quickjs, units: ["quickjs", "dtoa", "libregexp", "libunicode"],
    flags: ["-std=gnu11", "-O1", "-g", "-D_GNU_SOURCE", '-DCONFIG_VERSION="test"', ...SANITIZE],
  });
  binary = join(scratch, "harness");
  const shared = join(root, "engine/host-services");
  const build = Bun.spawnSync(
    [cc!, "-std=gnu11", "-O1", "-g", "-Wall", "-Wextra", "-Werror", ...SANITIZE, `-I${quickjs}`, `-I${shared}`,
      join(root, "tests/fixtures/link2-channel-qjs-harness.c"), join(shared, "link2_channel_qjs.c"), ...vendor, "-lm", "-lpthread", "-o", binary],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(build.exitCode, build.stderr.toString()).toBe(0);
}, 300_000);

/** The script's printed lines; the run fails on a sanitizer report, an exception or a non-zero exit. */
function run(script: string, ...args: string[]): string[] {
  const file = join(scratch, `${serial++}.js`);
  writeFileSync(file, script);
  const result = Bun.spawnSync([binary, file, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ASAN_OPTIONS: "detect_leaks=0:abort_on_error=0" } });
  const out = result.stdout.toString();
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode, out).toBe(0);
  const lines = out.trimEnd().split("\n");
  expect(lines.pop()).toBe("runtime freed");
  return lines;
}

describe("link.channel in QuickJS", () => {
  test("a handle whose conversion frees or shrinks the buffer beside it: the call takes the buffer afterwards", () => {
    expect(run(`
      var c = link.channel, h = c.request('{"t":"blob"}', false);
      var buf = new ArrayBuffer(4096);
      print("read", c.read({ valueOf: function () { buf.transfer(0); return h; } }, buf), pending());
      buf = new ArrayBuffer(4096);
      var view = new Uint8Array(buf, 16, 1024);
      print("write", c.write({ valueOf: function () { buf.transfer(8192); return h; } }, view), pending());
      buf = new ArrayBuffer(65536, { maxByteLength: 65536 });
      print("resized", c.read({ valueOf: function () { buf.resize(16); return h; } }, new Uint8Array(buf)), lastCall());
      buf = new ArrayBuffer(64);
      print("whole", c.read(h, buf), new Uint8Array(buf)[63]);
    `)).toEqual([
      "read -4 false",
      "write -4 false",
      // The view no longer fits the buffer it was made on: refused, and no read reached the client.
      "resized -4 request 3 12",
      "whole 64 171",
    ]);
  });

  test("a handle carries its generation: one of an earlier generation is refused and no call reaches the client", () => {
    const lines = run(`
      var c = link.channel;
      var old = c.request('{"t":"a"}', true), oldStream = c.emit('{"t":"log"}', true);
      print(old === 7 * 4294967296 + 3, oldStream === 7 * 4294967296 + 4, JSON.parse(c.poll()).id === old);
      reconnect();                       // generation 8, ids from 3 again
      var fresh = c.request('{"t":"b"}', true);
      print(fresh === 8 * 4294967296 + 3, fresh !== old, JSON.parse(c.state()).generation);
      var before = stubCalls(), buf = new Uint8Array(32);
      print(c.read(old, buf), c.write(old, buf), c.end(old), c.cancel(old), c.progress(old, "{}"), c.reply(old, "{}", false), c.close(old), c.close(old, true));
      print("calls for the stale handle:", stubCalls() - before, buf[0]);
      print(c.read(fresh, buf), lastCall(), buf[0]);
      print(c.read(3, buf), c.read(0, buf), c.read(-1, buf), c.read(1.5, buf), c.read(NaN, buf), c.read("x", buf), c.read(2 ** 53, buf));
      setGeneration(2097152 + 8);        // the 21 bits a handle carries
      print(c.read(fresh, buf));
    `);
    expect(lines).toEqual([
      "true true true",
      "true true 8",
      "-8 -8 -8 -8 -8 -8 undefined undefined",
      "calls for the stale handle: 0 0",
      "32 read 3 32 171",
      // A bare wire id is a handle of generation 0, which is not this one; the rest are no handles.
      "-8 -4 -4 -4 -4 -4 -4",
      "32",
    ]);
  });

  test("close abandons one side of an id; a request's response can go while its body stays", () => {
    expect(run(`
      var c = link.channel, h = c.request('{"t":"upload"}', true);
      c.close(h); print(lastCall());
      c.close(h, false); print(lastCall());
      c.close(h, true); print(lastCall());
    `)).toEqual(["close 3 1", "close 3 1", "close 3 2"]);
  });

  test("a value that does not convert gives a code and leaves no exception; nothing leaks over 20,000 rounds", () => {
    const lines = run(`
      var c = link.channel, bad = { toString: function () { throw new Error("no") } }, sym = Symbol("s");
      var h = c.request('{"t":"a"}', false);
      print(c.request(sym, false), pending(), c.request(bad, false), pending(), c.emit(sym, false), pending());
      print(c.reply(h, sym, false), pending(), c.progress(h, bad), pending(), c.cancel({ valueOf: function () { throw 1 } }), pending());
      print(c.read(h, 5), pending(), c.write(h, {}), pending(), c.read(sym, new Uint8Array(4)), pending());
      while (c.poll() !== undefined) {}
      var buf = new Uint8Array(256);
      function round() {
        var r = c.request('{"t":"echo","n":1}', true);
        c.poll(); c.state(); c.write(r, buf); c.end(r); c.read(r, buf); c.close(r); c.cancel(r);
        var s = c.emit('{"t":"e"}', true); c.write(s, buf); c.close(s, true);
        c.progress(r, '{"t":"p"}'); c.reply(r, '{}', false);
      }
      for (var i = 0; i < 200; i++) round();
      gc(); var before = mem();
      for (var i = 0; i < 20000; i++) round();
      gc(); print("malloc delta", mem() - before);
    `);
    expect(lines).toEqual([
      "-4 false -4 false -4 false",
      "-4 false -4 false -4 false",
      "-4 false -4 false -4 false",
      "malloc delta 0",
    ]);
  });

  test("a guest without a channel: every call answers no_channel or nothing", () => {
    expect(run(`
      var c = link.channel, buf = new Uint8Array(8);
      print(c.state());
      print(c.poll(), c.request('{"t":"a"}', false), c.cancel(5), c.emit('{"t":"a"}', false), c.progress(5, "{}"), c.reply(5, "{}", false), c.read(5, buf), c.write(5, buf), c.end(5), c.close(5));
    `, "--no-client")).toEqual([
      '{"state":"closed","reason":"no_link","generation":0}',
      "undefined -2 -2 -2 -2 -2 -2 -2 -2 undefined",
    ]);
  });
});
