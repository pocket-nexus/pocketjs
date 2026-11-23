import { describe, expect, test } from "bun:test";
import { encodeAtlas, parseAtlas, type AtlasGlyph } from "../../framework/src/pocketui/core/glyphfont.ts";
import { createRuntimeFaces, type GlyphRequest } from "../../framework/src/pocketui/core/runtimefaces.ts";

const REGULAR = { slot: 21, size: 13, line: 18 };
const BOLD = { slot: 22, size: 13, line: 18, bold: true };

/** A glyph service in memory: every character has a glyph unless `absent` names it; ASCII is 7 wide, the rest 13. */
function service(options: { absent?: number[]; down?: boolean } = {}) {
  const requests: GlyphRequest[] = [];
  const state = { down: options.down ?? false };
  const waiting: (() => void)[] = [];
  return {
    requests,
    state,
    /** let the replies out: a request is answered when the test says so */
    async flush() {
      while (waiting.length > 0) waiting.shift()!();
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
    transport: {
      textBytes: 60,
      atlas(request: GlyphRequest) {
        requests.push(request);
        return new Promise<Uint8Array>((resolve, reject) => {
          waiting.push(() => {
            if (state.down) return reject(new Error("unreachable"));
            const glyphs: AtlasGlyph[] = [...request.text]
              .map((ch) => ch.codePointAt(0)!)
              .filter((cp) => !options.absent?.includes(cp))
              .map((cp) => ({ cp, advance: cp < 0x80 ? 7 : 13, xoff: 0, cell: new Uint8Array(13 * 18 * request.density * request.density).fill(1) }));
            resolve(encodeAtlas({ slot: request.slot, bold: request.bold, cellW: 13, cellH: 18, baseline: 14, lineHeight: 18, density: request.density, glyphs }));
          });
        });
      },
    },
  };
}

function setup(options: Parameters<typeof service>[0] & { capacity?: number; idleLoadFrames?: number } = {}) {
  const glyphs = service(options);
  const loads: Uint8Array[] = [];
  const counts = { revision: 0, epoch: 0 };
  let onEpoch = () => {};
  const faces = createRuntimeFaces({
    transport: glyphs.transport,
    density: 2,
    regular: REGULAR,
    bold: BOLD,
    capacity: options.capacity,
    idleLoadFrames: options.idleLoadFrames,
    load: (atlas) => void loads.push(atlas),
    onRevision: () => void counts.revision++,
    onEpoch: () => {
      counts.epoch++;
      onEpoch();
    },
  });
  /** a frame, the replies to what it sent, and the frame that loads them */
  const turn = async () => {
    faces.tick();
    await glyphs.flush();
  };
  /** frames until nothing is asked for or on its way */
  const settle = async () => {
    for (let i = 0; i < 200 && !faces.settled(); i++) await turn();
    faces.tick();
    expect(faces.settled()).toBe(true);
  };
  return { glyphs, loads, counts, faces, turn, settle, mounted: (fn: () => void) => void (onEpoch = fn) };
}

describe("run-time faces", () => {
  test("a face starts with printable ASCII, asked for once", async () => {
    const { glyphs, faces, settle, loads } = setup();
    await settle();
    expect(glyphs.requests.length).toBe(2); // 95 characters, 60 to a request here
    expect(glyphs.requests.every((request) => request.slot === 21 && !request.bold && request.px === 13 && request.density === 2 && request.ascii === false)).toBe(true);
    expect(faces.stats().regular.glyphs).toBe(95);
    expect(parseAtlas(loads[loads.length - 1]!)!.glyphs.length).toBe(95);
    expect(faces.stats().bold.requests).toBe(0);
  });

  test("text asks only for the characters the face lacks, and each once", async () => {
    const { glyphs, faces, settle } = setup();
    await settle();
    glyphs.requests.length = 0;
    expect(faces.want("你好，世界", false)).toBe(false);
    expect(faces.want("你好", false)).toBe(false);
    await settle();
    expect(glyphs.requests.map((request) => [...request.text].sort().join(""))).toEqual([[..."你好，世界"].sort().join("")]);
    expect(faces.want("你好，世界", false)).toBe(true);
    // again, and a text that shares characters with it
    glyphs.requests.length = 0;
    expect(faces.want("世界你好 hello", false)).toBe(true);
    expect(faces.want("世界和平", false)).toBe(false);
    await settle();
    expect(glyphs.requests.map((request) => request.text)).toEqual(["平和"]);
  });

  test("a glyph that is here stays: wanting old text again sends and loads nothing", async () => {
    const { glyphs, faces, settle, loads, counts } = setup();
    const pages = ["第一页的文字内容", "第二页是别的东西", "第三页继续往下写"];
    for (const page of pages) {
      faces.want(page, false);
      await settle();
    }
    const before = { requests: glyphs.requests.length, loads: loads.length, revision: counts.revision };
    for (let pass = 0; pass < 3; pass++) for (const page of [...pages].reverse()) expect(faces.want(page, false)).toBe(true);
    for (let i = 0; i < 30; i++) faces.tick();
    expect({ requests: glyphs.requests.length, loads: loads.length, revision: counts.revision }).toEqual(before);
    expect(faces.stats().regular.evictions).toBe(0);
  });

  test("everything that arrived by a frame loads as one atlas and one notification", async () => {
    const { faces, settle, loads, counts, turn } = setup();
    await settle();
    const before = { loads: loads.length, revision: counts.revision };
    for (const text of ["你好", "世界", "和平"]) faces.want(text, false);
    await turn(); // the request goes and is answered
    faces.tick(); // the frame that loads
    expect(loads.length - before.loads).toBe(1);
    expect(counts.revision - before.revision).toBe(1);
    expect(parseAtlas(loads[loads.length - 1]!)!.glyphs.length).toBe(95 + 6);
  });

  test("the widths of a face come from its table", async () => {
    const { faces, settle } = setup();
    const measure = faces.measure(21)!;
    expect(faces.measure(20)).toBeNull();
    // not here yet: the face's size each
    expect(measure("你好")).toBe(26);
    faces.want("你好 ok", false);
    await settle();
    expect(measure("你好 ok")).toBe(26 + 7 * 3);
  });

  test("bold is a face of its own, made when bold text is first drawn", async () => {
    const { glyphs, faces, settle } = setup();
    await settle();
    glyphs.requests.length = 0;
    faces.want("标题", true);
    await settle();
    expect(glyphs.requests.every((request) => request.bold && request.slot === 22)).toBe(true);
    expect(faces.stats().bold.glyphs).toBe(95 + 2);
    expect(faces.want("标题", false)).toBe(false);
  });

  test("what is asked ahead goes behind text that is drawn, in the same request while there is room", async () => {
    const { glyphs, faces, settle, turn } = setup({ idleLoadFrames: 1000 });
    await settle();
    glyphs.requests.length = 0;
    const ahead = String.fromCodePoint(...Array.from({ length: 30 }, (_, i) => 0x6000 + i));
    faces.prefetch([ahead]);
    faces.want("眼前", false);
    await turn();
    // 60 bytes to a request here: the two on screen, then eighteen of the thirty
    expect(glyphs.requests[0]!.text).toBe(`前眼${ahead.slice(0, 18)}`);
    await settle();
    expect(glyphs.requests.map((request) => [...request.text].length)).toEqual([20, 12]);
    expect(faces.want(ahead, false)).toBe(true);
    expect(faces.stats().regular.glyphs).toBe(95 + 32);
  });

  test("a text that comes to want what was asked ahead brings its load forward", async () => {
    const { faces, settle, turn, loads } = setup({ idleLoadFrames: 1000 });
    await settle();
    const ahead = String.fromCodePoint(...Array.from({ length: 45 }, (_, i) => 0x5000 + i));
    const before = loads.length;
    faces.prefetch([ahead]);
    await turn(); // the first twenty arrive
    faces.tick(); // more are still to come, and nothing waits: no load yet
    expect(faces.stats().regular.glyphs).toBe(95 + 20);
    expect(loads.length).toBe(before);
    expect(faces.want(ahead.slice(0, 2), false)).toBe(true);
    faces.tick();
    expect(loads.length).toBe(before + 1);
    await settle();
    expect(faces.stats().regular.glyphs).toBe(95 + 45);
  });

  test("a character no font has is settled, not asked for again", async () => {
    const { glyphs, faces, settle, counts } = setup({ absent: [0x10ffff] });
    await settle();
    glyphs.requests.length = 0;
    const revision = counts.revision;
    expect(faces.want("\u{10ffff}", false)).toBe(false);
    await settle();
    expect(counts.revision).toBe(revision + 1);
    expect(faces.want("\u{10ffff}", false)).toBe(true);
    await settle();
    expect(glyphs.requests.length).toBe(1);
  });

  test("no service: the face is not offered, and it is tried again later", async () => {
    const { glyphs, faces, turn, counts } = setup({ down: true });
    expect(faces.face(false)).toEqual(REGULAR);
    await turn();
    expect(faces.face(false)).toBeNull();
    expect(counts.epoch).toBe(1);
    expect(faces.stats().regular.failures).toBe(1);
    // nothing more for three seconds of frames
    for (let i = 0; i < 100; i++) await turn();
    expect(glyphs.requests.length).toBe(1);
    glyphs.state.down = false;
    for (let i = 0; i < 100; i++) await turn();
    expect(faces.face(false)).toEqual(REGULAR);
    expect(counts.epoch).toBe(2);
    expect(faces.stats().regular.glyphs).toBe(95);
  });

  test("a failure after the face has loaded keeps the face and what it holds", async () => {
    const { glyphs, faces, settle, turn } = setup();
    faces.want("你好", false);
    await settle();
    glyphs.state.down = true;
    faces.want("世界", false);
    await turn();
    expect(faces.face(false)).toEqual(REGULAR);
    expect(faces.want("你好", false)).toBe(true);
    glyphs.state.down = false;
    for (let i = 0; i < 200; i++) await turn();
    expect(faces.want("世界", false)).toBe(true);
  });

  test("past the capacity, what no mounted text names goes; what one names stays", async () => {
    const { faces, settle, mounted } = setup({ capacity: 120 });
    const text = (from: number, count: number) => String.fromCodePoint(...Array.from({ length: count }, (_, i) => from + i));
    const onScreen = text(0x4e00, 20);
    mounted(() => void faces.want(onScreen, false));
    faces.want(onScreen, false);
    await settle();
    // pages that scrolled away, each named once
    for (let page = 1; page <= 6; page++) {
      faces.want(text(0x4e00 + page * 100, 20), false);
      await settle();
    }
    const stats = faces.stats().regular;
    expect(stats.evictions).toBeGreaterThan(0);
    expect(stats.glyphs).toBeLessThanOrEqual(120);
    expect(faces.want(onScreen, false)).toBe(true);
    // the latest page is still here too
    expect(faces.want(text(0x4e00 + 600, 20), false)).toBe(true);
  });
});
