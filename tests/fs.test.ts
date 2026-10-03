// Fs module unit tests: the sim host against the pinned op contract, and
// the Bun-shaped SDK over it. Runs entirely in-process; no disk.

import { afterEach, describe, expect, test } from "bun:test";
import {
  FS_MAX_DIR_ENTRIES,
  FS_MAX_IO_BYTES,
  FS_MAX_TEXT_BYTES,
  FS_WRITE_APPEND,
  FS_WRITE_TRUNCATE,
  fsValidPath,
} from "../contracts/spec/fs.ts";
import {
  appendFileSync,
  existsSync,
  file,
  fsHost,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  usage,
  write,
  writeFileSync,
} from "../framework/src/fs-api.ts";
import { createSimFsHost, type SimFsHost } from "../hosts/sim/fs.ts";

const g = globalThis as { fs?: unknown };
let host: SimFsHost | null = null;

/** Mount a fresh sim host as globalThis.fs, the way bootWorld's
 *  extraGlobals does for a scenario. */
function mount(options?: { quotaBytes?: number }): SimFsHost {
  host = createSimFsHost(options);
  g.fs = host.ns;
  return host;
}

afterEach(() => {
  host?.dispose();
  host = null;
  g.fs = undefined;
});

type Ns = {
  read(path: string, offset: number, maxBytes: number): string;
  readText(path: string): string;
  write(path: string, data: string, mode: number): number;
  remove(path: string, recursive: number): number;
  list(path: string, offset: number): string;
  stat(path: string): string;
  mkdir(path: string): number;
  rename(from: string, to: string): number;
  usage(): string;
  lastError(): string;
};

const text = (s: string) => JSON.stringify(s);

// --- the namespace contract (ops, straight through) -------------------------

describe("sim host ops", () => {
  test("the path grammar refuses traversal and escapes — and nothing else", () => {
    const ns = mount().ns as Ns;
    // The predicate itself is covered in the spec-constants block; here the
    // point is that the HOST enforces it on every op.
    for (const bad of ["", "/etc/passwd", "../up", "a/../b", "a//b", "a/", "a/.."]) {
      expect(JSON.parse(ns.read(bad, 0, 16)).error).toBe("invalid path");
      expect(ns.write(bad, text("x"), FS_WRITE_TRUNCATE)).toBe(1);
    }
    // Universal names: an app calls its files whatever it wants.
    for (const ok of ["notes/today.md", ".config", "笔记/今日笔记.md", "space in name.txt"]) {
      expect(ns.write(ok, text("ok"), FS_WRITE_TRUNCATE)).toBe(0);
      expect(JSON.parse(ns.stat(ok)).kind).toBe("file");
    }
  });

  test("write creates parents; truncate replaces; append appends", () => {
    const ns = mount().ns as Ns;
    expect(ns.write("a/b/c.txt", text("one"), FS_WRITE_TRUNCATE)).toBe(0);
    expect(JSON.parse(ns.stat("a/b")).kind).toBe("dir");
    expect(ns.write("a/b/c.txt", text("two"), FS_WRITE_TRUNCATE)).toBe(0);
    expect(ns.write("a/b/c.txt", text("+"), FS_WRITE_APPEND)).toBe(0);
    const read = JSON.parse(ns.read("a/b/c.txt", 0, FS_MAX_IO_BYTES));
    expect(read.size).toBe(4);
    expect(read.eof).toBe(true);
  });

  test("read pages with offset/eof and refuses out-of-range maxBytes", () => {
    const ns = mount().ns as Ns;
    ns.write("f.txt", text("abcdef"), FS_WRITE_TRUNCATE);
    const first = JSON.parse(ns.read("f.txt", 0, 4));
    expect(first.eof).toBe(false);
    const rest = JSON.parse(ns.read("f.txt", 4, 4));
    expect(rest.eof).toBe(true);
    expect(JSON.parse(ns.read("f.txt", 0, 0)).error).toContain("maxBytes");
    expect(JSON.parse(ns.read("f.txt", 0, FS_MAX_IO_BYTES + 1)).error).toContain("maxBytes");
  });

  test("readText returns complete strict UTF-8 above the binary per-call ceiling", () => {
    const ns = mount().ns as Ns;
    const chunk = "x".repeat(FS_MAX_IO_BYTES);
    expect(ns.write("big.txt", text(chunk), FS_WRITE_TRUNCATE)).toBe(0);
    expect(ns.write("big.txt", text("终"), FS_WRITE_APPEND)).toBe(0);
    expect(ns.readText("big.txt")).toBe(`${chunk}终`);
    expect(ns.lastError()).toBe("");

    expect(ns.write("bom.txt", text("\ufeffline\n\0"), FS_WRITE_TRUNCATE)).toBe(0);
    expect(ns.readText("bom.txt")).toBe("\ufeffline\n\0");

    expect(ns.write("empty.txt", text(""), FS_WRITE_TRUNCATE)).toBe(0);
    expect(ns.readText("missing.txt")).toBe("");
    expect(ns.lastError()).toBe("not found");
    expect(ns.readText("empty.txt")).toBe("");
    expect(ns.lastError()).toBe("");

    expect(ns.write("bad.bin", JSON.stringify({ $b: "/w==" }), FS_WRITE_TRUNCATE)).toBe(0);
    expect(ns.readText("bad.bin")).toBe("");
    expect(ns.lastError()).toBe("invalid UTF-8");
  });

  test("a payload beyond FS_MAX_IO_BYTES fails loudly", () => {
    const ns = mount().ns as Ns;
    expect(ns.write("big.bin", text("x".repeat(FS_MAX_IO_BYTES + 1)), FS_WRITE_TRUNCATE)).toBe(1);
    expect(ns.lastError()).toContain("FS_MAX_IO_BYTES");
  });

  test("list is name-sorted, pages, and stats carry kind/size", () => {
    const ns = mount().ns as Ns;
    ns.write("d/b.txt", text("xx"), FS_WRITE_TRUNCATE);
    ns.write("d/a.txt", text("x"), FS_WRITE_TRUNCATE);
    ns.mkdir("d/sub");
    const listing = JSON.parse(ns.list("d", 0));
    expect(listing.entries).toEqual([
      { name: "a.txt", kind: "file", size: 1 },
      { name: "b.txt", kind: "file", size: 2 },
      { name: "sub", kind: "dir", size: 0 },
    ]);
    expect(listing.eof).toBe(true);

    for (let i = 0; i < FS_MAX_DIR_ENTRIES + 2; i++) {
      ns.write(`many/f${String(i).padStart(4, "0")}`, text("x"), FS_WRITE_TRUNCATE);
    }
    const page1 = JSON.parse(ns.list("many", 0));
    expect(page1.entries.length).toBe(FS_MAX_DIR_ENTRIES);
    expect(page1.eof).toBe(false);
    const page2 = JSON.parse(ns.list("many", FS_MAX_DIR_ENTRIES));
    expect(page2.entries.length).toBe(2);
    expect(page2.eof).toBe(true);
  });

  test("stat('') is the root; a missing path is 'not found'", () => {
    const ns = mount().ns as Ns;
    expect(JSON.parse(ns.stat(""))).toEqual({ kind: "dir", size: 0 });
    expect(JSON.parse(ns.stat("ghost.txt")).error).toBe("not found");
    expect(JSON.parse(ns.list("", 0)).entries).toEqual([]);
  });

  test("remove: files, empty dirs, recursive trees; root refused", () => {
    const ns = mount().ns as Ns;
    ns.write("tree/deep/f.txt", text("x"), FS_WRITE_TRUNCATE);
    expect(ns.remove("tree", 0)).toBe(1);
    expect(ns.lastError()).toBe("directory not empty");
    expect(ns.remove("tree", 1)).toBe(0);
    expect(JSON.parse(ns.stat("tree")).error).toBe("not found");
    expect(ns.remove("", 0)).toBe(1);
    expect(ns.remove("ghost", 0)).toBe(1);
    expect(ns.lastError()).toBe("not found");
  });

  test("rename: atomic file replace, dir moves, guarded destinations", () => {
    const ns = mount().ns as Ns;
    ns.write("a.txt", text("A"), FS_WRITE_TRUNCATE);
    ns.write("b.txt", text("B"), FS_WRITE_TRUNCATE);
    expect(ns.rename("a.txt", "b.txt")).toBe(0);
    expect(JSON.parse(ns.stat("a.txt")).error).toBe("not found");
    ns.mkdir("sub");
    expect(ns.rename("b.txt", "sub")).toBe(1);
    expect(ns.lastError()).toBe("destination exists");
    expect(ns.rename("b.txt", "ghost/c.txt")).toBe(1);
    ns.write("sub/deep/f.txt", text("x"), FS_WRITE_TRUNCATE);
    expect(ns.rename("sub", "sub/inner")).toBe(1);
    expect(ns.rename("sub", "moved")).toBe(0);
    expect(JSON.parse(ns.stat("moved/deep/f.txt")).kind).toBe("file");
  });

  test("quota: writes beyond the budget fail; usage() reports", () => {
    const ns = mount({ quotaBytes: 10 }).ns as Ns;
    expect(ns.write("a.txt", text("12345678"), FS_WRITE_TRUNCATE)).toBe(0);
    expect(ns.write("b.txt", text("123"), FS_WRITE_TRUNCATE)).toBe(1);
    expect(ns.lastError()).toBe("quota exceeded");
    expect(ns.write("a.txt", text("1"), FS_WRITE_TRUNCATE)).toBe(0);
    expect(JSON.parse(ns.usage())).toEqual({ usedBytes: 1, quotaBytes: 10 });
  });
});

// --- the SDK (the Bun shape over the mounted namespace) ----------------------

describe("fs SDK", () => {
  test("throws where the module is unmounted", () => {
    expect(fsHost()).toBeNull();
    expect(() => write("a.txt", "x")).toThrow("data.fs");
    expect(() => file("a.txt").text()).toThrow("data.fs");
  });

  test("file()/write() round-trip text, bytes and json", () => {
    mount();
    expect(write("notes/today.md", "# 今天 🚀")).toBe(Buffer.byteLength("# 今天 🚀"));
    const f = file("notes/today.md");
    expect(f.exists()).toBe(true);
    expect(f.size).toBe(Buffer.byteLength("# 今天 🚀"));
    expect(f.text()).toBe("# 今天 🚀");

    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    write("raw.bin", bytes);
    expect(Array.from(file("raw.bin").bytes())).toEqual(Array.from(bytes));

    write("config.json", JSON.stringify({ theme: "dark", volume: 7 }));
    expect(file("config.json").json()).toEqual({ theme: "dark", volume: 7 });

    file("raw.bin").delete();
    expect(file("raw.bin").exists()).toBe(false);
  });

  test("payloads larger than FS_MAX_IO_BYTES chunk transparently", () => {
    mount();
    const big = new Uint8Array(FS_MAX_IO_BYTES * 2 + 123);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    write("big.bin", big);
    expect(file("big.bin").size).toBe(big.length);
    const back = file("big.bin").bytes();
    expect(back.length).toBe(big.length);
    expect(back[FS_MAX_IO_BYTES + 7]).toBe((FS_MAX_IO_BYTES + 7) % 251);

    const bigText = "样🚀x".repeat(40_000); // multi-byte, crosses chunk seams
    write("big.txt", bigText);
    expect(file("big.txt").text()).toBe(bigText);
  });

  test("the node:fs sync subset behaves like node", () => {
    const sim = mount();
    mkdirSync("a/b");
    writeFileSync("a/b/f.txt", "one");
    appendFileSync("a/b/f.txt", "+two");
    expect(readFileSync("a/b/f.txt", "utf8")).toBe("one+two");
    expect(sim.log.at(-1)).toBe("op readText a/b/f.txt");
    expect(readFileSync("a/b/f.txt")).toBeInstanceOf(Uint8Array);

    expect(readdirSync("a")).toEqual(["b"]);
    const entries = readdirSync("a/b", { withFileTypes: true });
    expect(entries[0].name).toBe("f.txt");
    expect(entries[0].isFile()).toBe(true);
    expect(statSync("a/b/f.txt").size).toBe(7);
    expect(statSync("a").isDirectory()).toBe(true);
    expect(existsSync("a/b/f.txt")).toBe(true);

    renameSync("a/b/f.txt", "a/g.txt");
    expect(existsSync("a/b/f.txt")).toBe(false);

    expect(() => rmSync("ghost.txt")).toThrow("not found");
    rmSync("ghost.txt", { force: true }); // node semantics: force swallows
    rmSync("a", { recursive: true });
    expect(existsSync("a")).toBe(false);

    expect(usage().usedBytes).toBe(0);
  });

  test("UTF-8 reads fall back to binary read on an older host", () => {
    const sim = mount();
    write("legacy.txt", "legacy ✓");
    sim.ns.readText = undefined;
    sim.log.length = 0;
    expect(readFileSync("legacy.txt", "utf8")).toBe("legacy ✓");
    expect(sim.log[0]).toBe(`op read legacy.txt 0 ${FS_MAX_IO_BYTES}`);
  });

  test("UTF-8 reads fall back to paged bytes above the text ceiling", () => {
    const sim = mount();
    const text = "x".repeat(FS_MAX_TEXT_BYTES + 1);
    write("large.txt", text);
    sim.log.length = 0;
    expect(readFileSync("large.txt", "utf8")).toBe(text);
    expect(sim.log[0]).toBe("op readText large.txt");
    expect(sim.log[1]).toBe(`op read large.txt 0 ${FS_MAX_IO_BYTES}`);
  });

  test("UTF-8 reads surface native validation failures", () => {
    mount();
    write("raw.bin", new Uint8Array([0xff]));
    expect(() => readFileSync("raw.bin", "utf8")).toThrow("invalid UTF-8");
    expect(Array.from(readFileSync("raw.bin"))).toEqual([0xff]);
  });

  test("errors surface as thrown Errors with the op detail", () => {
    mount();
    expect(() => readFileSync("missing.txt")).toThrow("not found");
    expect(() => readdirSync("missing")).toThrow("not found");
    expect(() => statSync("missing")).toThrow("not found");
    mkdirSync("d");
    expect(() => writeFileSync("d", "x")).toThrow("is a directory");
  });
});

// --- spec sanity --------------------------------------------------------------

describe("spec constants", () => {
  test("fsValidPath allows universal names and refuses only escapes", () => {
    for (const good of ["a", "notes/today.md", ".config", "笔记/今天.md", "a b", "a\\b"]) {
      expect(fsValidPath(good)).toBe(true);
    }
    for (const bad of ["", "/a", "a//b", "../x", "a/..", "a/.", "a/", "a\u0007b"]) {
      expect(fsValidPath(bad)).toBe(false);
    }
    expect(fsValidPath(Array(9).fill("a").join("/"))).toBe(false);
    expect(fsValidPath(Array(8).fill("a").join("/"))).toBe(true);
    expect(fsValidPath("名".repeat(22))).toBe(false); // 66 UTF-8 bytes > segment cap
    expect(fsValidPath("名".repeat(21))).toBe(true);
    // Ill-formed Unicode has no UTF-8 spelling: a lone surrogate would be
    // byte-exact on a JS host but mangled by the QuickJS-to-native bridge,
    // so the shared predicate refuses it; the paired form stays valid.
    expect(fsValidPath("a\uD800b")).toBe(false);
    expect(fsValidPath("a\uDC00b")).toBe(false);
    expect(fsValidPath("tail\uDBFF")).toBe(false);
    expect(fsValidPath("😀.txt")).toBe(true); // a real surrogate pair
  });
});
