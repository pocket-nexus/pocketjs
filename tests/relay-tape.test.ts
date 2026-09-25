import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import {
  createRelayFrameReplay,
  parseFrameTape,
  RelayFrameRecorder,
  sha256Hex,
  stringifyFrameTape,
  toHex,
  verifyFrameTape,
  wrapRelayTransport,
  type RelayFrameDirection,
  type RelayFrameTransport,
  type RelayFrameWrapOptions,
  type RelayRecordingTransport,
} from "../framework/src/relay/tape.ts";
import { decodeFrame } from "../framework/src/relay/frame.ts";

/** Enabled wrap with the union narrowed to the recording transport. */
function recording<T extends RelayFrameTransport>(
  inner: T,
  options: Omit<RelayFrameWrapOptions, "enabled"> = {},
): RelayRecordingTransport<T> {
  return wrapRelayTransport(inner, { ...options, enabled: true }) as RelayRecordingTransport<T>;
}

type MutableTape = {
  kind: "relay-frame"; v: 1; session: string;
  frames: [RelayFrameDirection, number, string, string][];
};

const FIX = new URL("./fixtures/relay/", import.meta.url);

async function loadBin(name: string): Promise<Uint8Array> {
  const spec = await Bun.file(new URL(`vectors/${name}.json`, FIX)).json() as { file: string };
  return new Uint8Array(await Bun.file(new URL(spec.file, FIX)).arrayBuffer());
}

// --- step 1: sha256 -----------------------------------------------------------

test("sha256: FIPS 180-4 known-answer vectors", () => {
  expect(sha256Hex(new TextEncoder().encode("")))
    .toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Hex(new TextEncoder().encode("abc")))
    .toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256Hex(new TextEncoder().encode(
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
  ))).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});

test("sha256: padding block boundaries (54/55/56/63/64/65 bytes)", () => {
  // Boundaries: message ends 2 bytes short of a full block, exactly at the
  // 0x80+length threshold, and one byte each side of a full 64-byte block.
  for (const len of [54, 55, 56, 63, 64, 65, 119, 120, 127, 128]) {
    const msg = new Uint8Array(len).fill(0x61);
    expect(sha256Hex(msg)).toBe(createHash("sha256").update(msg).digest("hex"));
  }
});

test("sha256: one million 'a' bytes", () => {
  expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61)))
    .toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("sha256: 200 deterministic random buffers match node:crypto", () => {
  let seed = 0x52454c41;
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < 200; i++) {
    const msg = Uint8Array.from({ length: Math.floor(rnd() * 300) }, () => Math.floor(rnd() * 256));
    expect(sha256Hex(msg)).toBe(createHash("sha256").update(msg).digest("hex"));
  }
});

// --- step 2: recorder + format ------------------------------------------------

test("record a P1 vector sequence: tuples are exactly (direction, seq, frameHex, sha256)", async () => {
  const session = 0x0102030405060708n;
  const script = [
    ["ping", "out"], ["response-final", "in"], ["get", "out"], ["credit", "in"],
  ] as const;
  const rec = new RelayFrameRecorder({ session });
  for (const [name, dir] of script) {
    const bin = await loadBin(name);
    rec.note(bin, dir);
  }
  expect(rec.framesRecorded).toBe(4);
  const tape = rec.toTape();
  expect(tape.kind).toBe("relay-frame");
  expect(tape.v).toBe(1);
  expect(tape.session).toBe("0102030405060708");
  expect(Object.keys(tape).sort()).toEqual(["frames", "kind", "session", "v"]);
  expect(tape.frames.map((e) => e[0])).toEqual(["out", "in", "out", "in"]);
  expect(tape.frames.map((e) => e[1])).toEqual([3, 1, 1, 4]);
  for (const tuple of tape.frames) {
    expect(tuple).toHaveLength(4);
    const bytes = Uint8Array.from(
      tuple[2].match(/../g)!.map((h) => parseInt(h, 16)),
    );
    expect(tuple[3]).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
});

test("bootstrap session 0 records as session 0000000000000000", async () => {
  const rec = new RelayFrameRecorder();
  rec.noteOut(await loadBin("hello"));
  rec.noteIn(await loadBin("hello-response"));
  expect(rec.toTape().session).toBe("0000000000000000");
});

test("a frame from another session is refused", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  const hello = await loadBin("hello");
  expect(() => rec.noteIn(hello)).toThrow(/does not match tape session/);
});

test("records must be complete PRLY records", async () => {
  const rec = new RelayFrameRecorder();
  const good = await loadBin("ping");
  expect(() => rec.noteOut(good.subarray(0, 40))).toThrow(/short record/);
  const badMagic = good.slice(); badMagic[4] = 0x58;
  expect(() => rec.noteOut(badMagic)).toThrow(/PRLY/);
  const badLen = good.slice(); new DataView(badLen.buffer).setUint32(0, 999, true);
  expect(() => rec.noteOut(badLen)).toThrow(/prefix declares/);
});

test("a structurally complete seq-0 frame is not recorded", async () => {
  // seq-zero.bin is a complete PRLY record that the L1 codec rejects;
  // recording rejects it too, so a produced tape always round-trips parse.
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  const zeroSeq = await loadBin("seq-zero");
  expect(() => rec.noteOut(zeroSeq)).toThrow(/seq is 0/);
});

test("note() rejects a direction other than \"in\"/\"out\" before touching the frame", async () => {
  // M25: the direction argument guard is a tape rule, not optional input.
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  const ping = await loadBin("ping");
  expect(() => rec.note(ping, "sideways" as RelayFrameDirection)).toThrow(/direction must be/);
  expect(rec.framesRecorded).toBe(0);
});

test("recording off by default: wrapRelayTransport returns the inner transport itself", () => {
  const sent: Uint8Array[] = [];
  const inner = {
    send: (f: Uint8Array) => sent.push(f),
    recv: () => null as Uint8Array | null,
  };
  // No options, and explicit false: same object identity in both cases.
  expect(wrapRelayTransport(inner)).toBe(inner);
  expect(wrapRelayTransport(inner, { enabled: false })).toBe(inner);
  const t = wrapRelayTransport(inner) as typeof inner;
  expect("relayRecorder" in t).toBe(false);
  // A recorder that exists but never observes a frame keeps zero counters.
  const rec = new RelayFrameRecorder();
  expect(rec.framesRecorded).toBe(0);
  expect(rec.bytesRecorded).toBe(0);
});

test("enabled wrapper records both directions and delegates every byte", async () => {
  const ping = await loadBin("ping");
  const credit = await loadBin("credit");
  const inbox = [credit];
  const sent: Uint8Array[] = [];
  const inner = {
    send: (f: Uint8Array) => sent.push(f),
    recv: () => inbox.shift() ?? null,
  };
  const t = recording(inner, { session: 0x0102030405060708n });
  expect(t).not.toBe(inner);
  if (!("relayRecorder" in t)) throw new Error("enabled wrapper should carry a recorder");
  t.send(ping);
  expect(t.recv()).toBe(credit);
  expect(t.recv()).toBeNull();
  expect(sent).toEqual([ping]);
  expect(t.relayRecorder.framesRecorded).toBe(2);
  expect(t.relayRecorder.bytesRecorded).toBe(ping.length + credit.length);
  const tape = t.relayRecorder.toTape();
  expect(tape.frames.map((e) => e[0])).toEqual(["out", "in"]);
});

// --- step 3: parse / verify / replay ------------------------------------------

test("parseFrameTape round-trips and rejects the input tape format", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  const tape = rec.toTape();
  const parsed = parseFrameTape(stringifyFrameTape(tape));
  expect(parsed).toEqual(tape);
  // Input tape v1 (tools/tape.ts writes {v, app, frames, masks}).
  expect(() => parseFrameTape(JSON.stringify({ v: 1, app: "hero-main", frames: 1, masks: [] })))
    .toThrow(/input tape/);
  // Input tape v2/v3 shape is refused the same way.
  expect(() => parseFrameTape(JSON.stringify({ v: 3, app: "x", frames: 1, masks: [], touch: [] })))
    .toThrow(/input tape/);
});

test("parseFrameTape rejects every structural deviation", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  const base = rec.toTape();
  const bad = (mut: (t: unknown) => void) => {
    const t = JSON.parse(JSON.stringify(base)) as unknown;
    mut(t);
    return () => parseFrameTape(JSON.stringify(t));
  };
  expect(bad((t) => { (t as { kind: string }).kind = "input"; })).toThrow(/kind/);
  expect(bad((t) => { (t as { v: number }).v = 2; })).toThrow(/tape v/);
  expect(bad((t) => { (t as { session: string }).session = "deadbeef"; })).toThrow(/session/);
  expect(bad((t) => { (t as { frames: unknown[] }).frames = []; })).not.toThrow(); // empty is parseable
  expect(bad((t) => { (t as { frames: unknown[] }).frames = [["out", 1, "aa".repeat(48)]]; }))
    .toThrow(/4-tuple/);
  expect(bad((t) => { (t as { frames: unknown[][] }).frames[0][0] = "up"; })).toThrow(/direction/);
  expect(bad((t) => { (t as { frames: unknown[][] }).frames[0][1] = 0; })).toThrow(/seq/);
  // M20: frameHex shorter than one 48-byte record (< 96 hex chars) is a
  // structural rejection, even when even-length and the digest is valid.
  expect(bad((t) => { (t as { frames: unknown[][] }).frames[0][2] = "ab".repeat(24); }))
    .toThrow(/frameHex/);
  expect(bad((t) => { (t as { frames: unknown[][] }).frames[0][3] = "z".repeat(64); })).toThrow(/sha256/);
});

test("verifyFrameTape: recorded tape verifies; one tampered byte reports that tuple's seq", async () => {
  const names = ["ping", "response-final", "get", "credit"] as const;
  const dirs = ["out", "in", "out", "in"] as const;
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  for (const name of names) rec.note(await loadBin(name), dirs[names.indexOf(name)]);
  const tape = rec.toTape();
  expect(verifyFrameTape(tape).ok).toBe(true);

  // Tamper one metadata byte in tuple index 2 ("get", seq 1): length prefix
  // and header stay intact, so the divergence is digest at that exact index.
  const tampered = JSON.parse(JSON.stringify(tape)) as MutableTape;
  const frameHex = tampered.frames[2][2];
  const flipAt = 48 * 2 + 4; // first metadata byte after the 48-byte header
  const ch = frameHex[flipAt] === "0" ? "1" : "0";
  tampered.frames[2] = [tampered.frames[2][0], tampered.frames[2][1],
    frameHex.slice(0, flipAt) + ch + frameHex.slice(flipAt + 1), tampered.frames[2][3]];
  const v = verifyFrameTape(tampered);
  expect(v.ok).toBe(false);
  expect(v.frames).toBe(2);
  expect(v.divergence!.index).toBe(2);
  expect(v.divergence!.seq).toBe(tape.frames[2][1]);
  expect(v.divergence!.code).toBe("digest");
});

test("verifyFrameTape: a tape whose document session disagrees with the frame header is refused (M07/CE2)", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  const tape = rec.toTape();
  // The frame header still carries 0102030405060708; only the document
  // field lies. verifyFrameTape must return a record divergence at index 0.
  const forged = { ...tape, session: "00000000000000ff" };
  const v = verifyFrameTape(forged);
  expect(v.ok).toBe(false);
  expect(v.frames).toBe(0);
  expect(v.divergence!.index).toBe(0);
  expect(v.divergence!.seq).toBe(tape.frames[0][1]);
  expect(v.divergence!.code).toBe("record");
  expect(v.divergence!.detail).toMatch(/does not match tape session/);
});

test("replay: P1 vector sequence replays OK in capture order", async () => {
  const names = ["ping", "response-final", "get", "credit"] as const;
  const dirs = ["out", "in", "out", "in"] as const;
  const bins = new Map<string, Uint8Array>();
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  for (const name of names) {
    const bin = await loadBin(name);
    bins.set(name, bin);
    rec.note(bin, dirs[names.indexOf(name)]);
  }
  const tape = parseFrameTape(stringifyFrameTape(rec.toTape()));
  const replay = createRelayFrameReplay(tape);

  // Drive the fake session the same way the recorded session ran: outbound
  // frames are produced, inbound frames are pulled and byte-compared.
  replay.send(bins.get("ping")!);
  const reply = replay.recv();
  expect(Buffer.compare(Buffer.from(reply!), Buffer.from(bins.get("response-final")!))).toBe(0);
  replay.send(bins.get("get")!);
  const push = replay.recv();
  expect(Buffer.compare(Buffer.from(push!), Buffer.from(bins.get("credit")!))).toBe(0);
  const verdict = replay.result();
  expect(verdict.ok, verdict.divergence?.detail).toBe(true);
  expect(replay.framesChecked).toBe(4);
  // Fed-back bytes still decode through the P1 codec.
  expect(decodeFrame(reply!, { maxWireBytes: 4096 }).ok).toBe(true);
});

test("replay: a tampered outbound frame reports the first divergent seq", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  rec.noteIn(await loadBin("credit"));
  const replay = createRelayFrameReplay(parseFrameTape(stringifyFrameTape(rec.toTape())));
  const mutated = (await loadBin("ping")).slice();
  mutated[52] ^= 0x01;
  replay.send(mutated);
  const v = replay.result();
  expect(v.ok).toBe(false);
  expect(v.divergence!.index).toBe(0);
  expect(v.divergence!.seq).toBe(3); // ping seq
  expect(v.divergence!.code).toBe("digest");
  // The latch is sticky: later correct calls do not clear it.
  replay.recv();
  expect(replay.result().divergence!.seq).toBe(3);
});

test("replay: a tampered inbound record surfaces at the recv step", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  rec.noteIn(await loadBin("credit"));
  const tape = rec.toTape();
  const tampered = JSON.parse(JSON.stringify(tape)) as MutableTape;
  const hex = tampered.frames[1][2];
  tampered.frames[1] = [tampered.frames[1][0], tampered.frames[1][1],
    hex.slice(0, 200) + (hex[200] === "a" ? "b" : "a") + hex.slice(201), tampered.frames[1][3]];
  const replay = createRelayFrameReplay(tampered);
  replay.send(await loadBin("ping"));
  expect(replay.recv()).toBeNull();
  const v = replay.result();
  expect(v.ok).toBe(false);
  expect(v.divergence!.index).toBe(1);
  expect(v.divergence!.seq).toBe(4); // credit seq
});

test("replay: wrong direction, extra frame, and early stop each report their code", async () => {
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(await loadBin("ping"));
  rec.noteIn(await loadBin("credit"));
  const make = () => createRelayFrameReplay(parseFrameTape(stringifyFrameTape(rec.toTape())));

  // recv() at an outbound entry is a non-blocking poll: null, no divergence.
  // Sending at an inbound entry latches the direction error at that index.
  let replay = make();
  expect(replay.recv()).toBeNull();
  replay.send(await loadBin("ping")); // consumes entry 0 (out)
  replay.send(await loadBin("ping")); // entry 1 is inbound → direction
  const d = replay.result().divergence!;
  expect(d.code).toBe("direction");
  expect(d.index).toBe(1);
  expect(d.seq).toBe(4); // credit seq

  // Clean run plus one extra send → unexpected at end.
  replay = make();
  replay.send(await loadBin("ping"));
  replay.recv();
  replay.send(await loadBin("ping"));
  expect(replay.result().divergence!.code).toBe("unexpected");

  // Stop after the first frame → incomplete naming the remaining tuple.
  replay = make();
  replay.send(await loadBin("ping"));
  const v = replay.result();
  expect(v.divergence!.code).toBe("incomplete");
  expect(v.divergence!.index).toBe(1);
});

// --- review 964 F1: recording never changes observable transport behavior ----
// R5 §3.11: partial record loss marks the trace incomplete; the recorder is
// a passive observer and must not suppress, delay, or reorder a live frame.

test("enabled wrapper delivers a foreign-session frame and marks the trace incomplete (CE1)", async () => {
  const ping = await loadBin("ping");   // session 0102030405060708
  const hello = await loadBin("hello"); // bootstrap session 0
  const sent: Uint8Array[] = [];
  const inner = {
    send: (f: Uint8Array) => sent.push(f),
    recv: () => null as Uint8Array | null,
  };
  const t = recording(inner, { session: 0x0102030405060708n });
  t.send(ping);
  // Pre-fix this threw "frame session 0000…0 does not match tape session"
  // and the frame never reached inner.send.
  expect(() => t.send(hello)).not.toThrow();
  expect(sent).toEqual([ping, hello]); // both frames crossed the wire
  const rec = t.relayRecorder;
  expect(rec.framesRecorded).toBe(1); // the foreign frame was not appended
  expect(rec.incomplete).not.toBeNull();
  expect(rec.incomplete!.index).toBe(1);
  expect(rec.incomplete!.reason).toMatch(/does not match tape session/);
  const tape = rec.toTape();
  expect(tape.incomplete?.reason).toMatch(/does not match tape session/);
  // R5 §3.11: an incomplete trace is neither a conformance pass nor a replay.
  const v = verifyFrameTape(tape);
  expect(v.ok).toBe(false);
  expect(v.divergence!.code).toBe("tape-incomplete");
  expect(() => createRelayFrameReplay(tape)).toThrow(/incomplete trace/);
  // After the first loss no later frame is appended; the wire stays live.
  t.send(ping);
  expect(sent).toHaveLength(3);
  expect(t.relayRecorder.framesRecorded).toBe(1);
});

test("frame cap marks the trace incomplete without stopping sends (CE1b)", async () => {
  const ping = await loadBin("ping");
  const sent: Uint8Array[] = [];
  const inner = {
    send: (f: Uint8Array) => sent.push(f),
    recv: () => null as Uint8Array | null,
  };
  const t = recording(inner, { session: 0x0102030405060708n, maxFrames: 2 });
  t.send(ping); t.send(ping);
  expect(() => t.send(ping)).not.toThrow(); // pre-fix: "frame cap 2 reached"
  expect(sent).toHaveLength(3);
  expect(t.relayRecorder.framesRecorded).toBe(2);
  expect(t.relayRecorder.incomplete?.index).toBe(2);
  expect(t.relayRecorder.incomplete?.reason).toMatch(/frame cap 2 reached/);
  // The two stored frames are a clean prefix and still verify individually.
  const tape = t.relayRecorder.toTape();
  expect(tape.frames).toHaveLength(2);
  expect(tape.incomplete?.index).toBe(2);
});

test("HELLO->assigned-session boundary: every frame delivered, trace marked incomplete (CE6)", async () => {
  const hello = await loadBin("hello");
  const helloResp = await loadBin("hello-response");
  const ping = await loadBin("ping");
  const sent: Uint8Array[] = [];
  const inbox = [helloResp, ping]; // response on session 0, then assigned-session frame
  const inner = {
    send: (f: Uint8Array) => sent.push(f),
    recv: () => inbox.shift() ?? null,
  };
  const t = recording(inner); // unpinned: HELLO pins 0
  expect(() => t.send(hello)).not.toThrow();
  expect(t.recv()).toBe(helloResp);
  // Pre-fix the first assigned-session frame was dropped and send() threw.
  expect(() => t.send(ping)).not.toThrow();
  expect(sent).toEqual([hello, ping]);
  const rec = t.relayRecorder;
  expect(rec.toTape().session).toBe("0000000000000000");
  expect(rec.framesRecorded).toBe(2); // hello out + hello-response in
  expect(rec.incomplete?.index).toBe(2);
  expect(rec.incomplete?.reason).toMatch(/does not match tape session/);
  // The post-boundary inbound frame is delivered but not appended either.
  expect(t.recv()).toBe(ping);
  expect(rec.framesRecorded).toBe(2);
});

test("the bootstrap boundary is the session-pin rule, not the frame cap; wrapping after READY records a complete tape", async () => {
  // Review 986: docs/RELAY.md called this boundary the "cap rule";
  // maxFrames plays no part in it. Three recorders over the same script.
  const hello = await loadBin("hello");              // session 0, seq 1
  const helloResp = await loadBin("hello-response"); // session 0
  const ping = await loadBin("ping");                // assigned session 0102030405060708
  const credit = await loadBin("credit");
  const assigned = 0x0102030405060708n;
  const scripted = (inbox: Uint8Array[]) => {
    const queue = [...inbox];
    return { send: () => {}, recv: () => queue.shift() ?? null };
  };

  // Unpinned, wrapped from HELLO, cap far above the frame count: the first
  // recorded frame (HELLO) pins session 0 and the marker names the pin rule.
  const t1 = recording(scripted([helloResp, credit]), { maxFrames: 1000 });
  t1.send(hello); t1.recv(); t1.send(ping); t1.recv();
  expect(t1.relayRecorder.toTape().session).toBe("0000000000000000");
  expect(t1.relayRecorder.incomplete?.index).toBe(2);
  expect(t1.relayRecorder.incomplete?.reason).toMatch(/does not match tape session/);
  expect(t1.relayRecorder.incomplete?.reason).not.toMatch(/frame cap/);

  // Pinned to the assigned session but wrapped from HELLO: HELLO is the
  // loss at index 0 and the trace has no serializable tape.
  const t2 = recording(scripted([helloResp, credit]), { session: assigned });
  t2.send(hello); t2.recv(); t2.send(ping); t2.recv();
  expect(t2.relayRecorder.framesRecorded).toBe(0);
  expect(t2.relayRecorder.incomplete?.index).toBe(0);
  expect(t2.relayRecorder.incomplete?.reason).toMatch(/does not match tape session/);
  expect(() => t2.relayRecorder.toTape()).toThrow(/before any valid record/);

  // Wrapped after READY (the bootstrap frames do not pass the wrapper) and
  // pinned to the assigned session: a complete post-bootstrap tape.
  const t3 = recording(scripted([credit]), { session: assigned });
  t3.send(ping); t3.recv();
  const tape = t3.relayRecorder.toTape();
  expect(tape.session).toBe("0102030405060708");
  expect(tape.incomplete).toBeUndefined();
  expect(tape.frames.map((e) => e[0])).toEqual(["out", "in"]);
  expect(verifyFrameTape(tape).ok).toBe(true);
  expect(() => createRelayFrameReplay(tape)).not.toThrow();
});

test("a seq-0 frame is delivered on the wire and latches incomplete instead of throwing", async () => {
  const zeroSeq = await loadBin("seq-zero"); // complete PRLY record, same session, seq 0
  const sent: Uint8Array[] = [];
  const inner = {
    send: (f: Uint8Array) => sent.push(f),
    recv: () => null as Uint8Array | null,
  };
  const t = recording(inner, { session: 0x0102030405060708n });
  expect(() => t.send(zeroSeq)).not.toThrow();
  expect(sent).toEqual([zeroSeq]);
  expect(t.relayRecorder.framesRecorded).toBe(0);
  expect(t.relayRecorder.incomplete?.reason).toMatch(/seq is 0/);
});

test("a recv()d foreign-session frame is returned and the trace marked incomplete", async () => {
  const hello = await loadBin("hello");
  const inner = { send: () => {}, recv: () => hello };
  const t = recording(inner, { session: 0x0102030405060708n });
  expect(t.recv()).toBe(hello); // the caller gets the bytes regardless
  expect(t.relayRecorder.incomplete?.reason).toMatch(/does not match tape session/);
});

test("recv(): the inner result is recorded inside the call and returned; null/undefined return null and record nothing", async () => {
  // Review 986 C2: the wrapper calls inner.recv(), hands a non-null frame
  // to the recorder, then returns it; the allowed undefined comes back as
  // null. The order is observable: the tape holds the frame by the time
  // recv() has returned it.
  const credit = await loadBin("credit"); // session 0102030405060708, seq 4
  const results: (Uint8Array | null | undefined)[] = [undefined, null, credit];
  const inner = { send: () => {}, recv: () => results.shift() };
  const t = recording(inner, { session: 0x0102030405060708n });
  expect(t.recv()).toBeNull(); // inner undefined -> null
  expect(t.recv()).toBeNull(); // inner null -> null
  expect(t.relayRecorder.framesRecorded).toBe(0);
  expect(t.relayRecorder.incomplete).toBeNull(); // an empty poll is not a record loss
  expect(t.recv()).toBe(credit); // the inner object itself, not a copy
  expect(t.relayRecorder.framesRecorded).toBe(1);
  expect(t.relayRecorder.toTape().frames[0]).toEqual(["in", 4, toHex(credit), sha256Hex(credit)]);
  expect(t.recv()).toBeNull(); // exhausted inner (undefined) -> null, nothing appended
  expect(t.relayRecorder.framesRecorded).toBe(1);
});

test("recv() returns a frame the recorder rejects under any rule: foreign session, seq 0, frame cap", async () => {
  // The fact behind "off the live path": a capture rejection cannot
  // withhold a frame inner.recv() has produced. seq 0 and the cap were
  // pinned for send() only; each rule is exercised on the inbound side.
  const hello = await loadBin("hello");       // session 0: foreign to the pin
  const zeroSeq = await loadBin("seq-zero");  // pinned session, seq 0
  const ping = await loadBin("ping");
  const pin = { session: 0x0102030405060708n };
  const cases: [string, Uint8Array[], Omit<RelayFrameWrapOptions, "enabled">, RegExp][] = [
    ["foreign session", [hello], pin, /does not match tape session/],
    ["seq 0", [zeroSeq], pin, /seq is 0/],
    ["frame cap", [ping, ping], { ...pin, maxFrames: 1 }, /frame cap 1 reached/],
  ];
  for (const [name, inbox, options, reason] of cases) {
    const queue = [...inbox];
    const t = recording({ send: () => {}, recv: () => queue.shift() ?? null }, options);
    const returned = inbox.map(() => t.recv());
    expect(returned, name).toEqual(inbox); // every produced frame reached the caller
    expect(t.relayRecorder.incomplete?.reason, name).toMatch(reason);
    expect(t.relayRecorder.framesRecorded, name).toBe(inbox.length - 1);
  }
});

test("when inner.send throws the error propagates and nothing is recorded", async () => {
  const ping = await loadBin("ping");
  const boom = new Error("wire down");
  const inner = { send: () => { throw boom; }, recv: () => null };
  const t = recording(inner, { session: 0x0102030405060708n });
  expect(() => t.send(ping)).toThrow(boom); // recording does not swallow transport errors
  expect(t.relayRecorder.framesRecorded).toBe(0);
  expect(t.relayRecorder.incomplete).toBeNull(); // a failed send is not a record loss
});

test("enabled and disabled wrappers deliver the same frame sequence (observable behavior)", async () => {
  const ping = await loadBin("ping");
  const credit = await loadBin("credit");
  const mk = () => {
    const sent: Uint8Array[] = [];
    const inbox = [credit];
    return {
      sent,
      inner: { send: (f: Uint8Array) => sent.push(f), recv: () => inbox.shift() ?? null },
    };
  };
  const off = mk();
  wrapRelayTransport(off.inner).send(ping);
  (wrapRelayTransport(off.inner).recv());

  const on = mk();
  const t = recording(on.inner, { session: 0x0102030405060708n });
  t.send(ping);
  t.recv();
  // The wire sees the same sends with and without recording.
  expect(on.sent).toEqual(off.sent);
  expect(on.sent[0]).toBe(ping);
});

test("an incomplete trace round-trips through parseFrameTape; a structurally bad marker is rejected", async () => {
  const ping = await loadBin("ping");
  const t = recording(
    { send: () => {}, recv: () => null },
    { session: 0x0102030405060708n, maxFrames: 1 },
  );
  t.send(ping);
  t.send(ping); // cap -> incomplete at index 1
  const text = stringifyFrameTape(t.relayRecorder.toTape());
  const parsed = parseFrameTape(text);
  expect(parsed.incomplete?.index).toBe(1);
  expect(parsed.incomplete?.reason).toMatch(/frame cap/);
  const badMarker = (mut: (o: { incomplete?: unknown }) => void) => () => {
    const o = JSON.parse(text) as { incomplete?: unknown };
    mut(o);
    return parseFrameTape(JSON.stringify(o));
  };
  expect(badMarker((o) => { o.incomplete = "yes"; })).toThrow(/incomplete must be an object/);
  expect(badMarker((o) => { o.incomplete = { index: -1, reason: "x" }; })).toThrow(/incomplete.index/);
  expect(badMarker((o) => { o.incomplete = { index: 1, reason: "" }; })).toThrow(/incomplete.reason/);
  expect(badMarker((o) => { o.incomplete = { index: 99, reason: "x" }; })).toThrow(/incomplete.index/);
});

test("a trace that loses every frame before the first valid record cannot be serialized", async () => {
  const hello = await loadBin("hello");
  const t = recording(
    { send: () => {}, recv: () => null },
    { session: 0x0102030405060708n },
  );
  t.send(hello); // foreign session, zero valid entries captured
  expect(() => t.relayRecorder.toTape()).toThrow(/lost its frame before any valid record/);
});

// ------------------------------------------------------------------------------

test("benchmark: record + serialize 10,000 frames", async () => {
  const ping = await loadBin("ping");
  const rec = new RelayFrameRecorder();
  const start = performance.now();
  for (let i = 0; i < 10_000; i++) rec.note(ping, i % 2 === 0 ? "out" : "in");
  const text = stringifyFrameTape(rec.toTape());
  const ms = performance.now() - start;
  console.log(
    `relay record+serialize 10000 frames: ${ms.toFixed(1)} ms `
      + `(${(ms / 10_000 * 1000).toFixed(2)} µs/frame), file ${text.length} bytes `
      + `(${(text.length / 10_000).toFixed(1)} B/frame, ${rec.bytesRecorded} wire bytes)`,
  );
  expect(rec.framesRecorded).toBe(10_000);
  expect(parseFrameTape(text).frames).toHaveLength(10_000);
  expect(ms).toBeLessThan(5000);
});

// --- review 1070 N3: verify and replay share the identity and order rules ----

test("N3: a forged document session fails replay at index 0, as it fails verification", async () => {
  // Review 1070's TAPE_INTEGRITY_GAPS probe: the forged tape failed
  // verifyFrameTape but replayed OK, because replay never compared the
  // document session with the header.
  const ping = await loadBin("ping");
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(ping);
  const forged = { ...rec.toTape(), session: "00000000000000ff" };
  expect(verifyFrameTape(forged).ok).toBe(false);
  const replay = createRelayFrameReplay(forged);
  replay.send(ping);
  const v = replay.result();
  expect(v.ok).toBe(false);
  expect(v.divergence!.code).toBe("record");
  expect(v.divergence!.index).toBe(0);
  expect(v.divergence!.detail).toMatch(/does not match tape session/);
});

test("N3: a tuple seq that disagrees with the header seq is a record divergence for both verify and replay", async () => {
  const ping = await loadBin("ping"); // header seq 3
  const rec = new RelayFrameRecorder({ session: 0x0102030405060708n });
  rec.noteOut(ping);
  const lie = JSON.parse(stringifyFrameTape(rec.toTape())) as MutableTape;
  lie.frames[0][1] = 999;
  const tape = parseFrameTape(JSON.stringify(lie));
  const v = verifyFrameTape(tape);
  expect(v.ok).toBe(false);
  expect(v.divergence).toMatchObject({ index: 0, seq: 999, code: "record" });
  expect(v.divergence!.detail).toMatch(/tuple seq 999 does not match header seq 3/);
  const replay = createRelayFrameReplay(tape);
  replay.send(ping);
  expect(replay.result().divergence).toMatchObject({ index: 0, seq: 999, code: "record" });
});

test("N3: an empty tape is not a verdict: verify reports empty and replay refuses to build", () => {
  const empty = parseFrameTape(JSON.stringify({ kind: "relay-frame", v: 1, session: "0102030405060708", frames: [] }));
  const v = verifyFrameTape(empty);
  expect(v.ok).toBe(false);
  expect(v.frames).toBe(0);
  expect(v.divergence!.code).toBe("empty");
  expect(() => createRelayFrameReplay(empty)).toThrow(/no frames/);
});

test("N3: within one (direction, stream) seq must increase in capture order; other streams and directions are independent", async () => {
  const ready = await loadBin("ready"); // out, stream 0, seq 1
  const ping = await loadBin("ping");   // out, stream 0, seq 3
  const get = await loadBin("get");     // out, stream 1, seq 1
  const credit = await loadBin("credit"); // in, stream 0, seq 4
  const session = 0x0102030405060708n;

  // Increasing (1, 3) on out/stream 0 is accepted: a tape wrapped after
  // READY starts above 1 and gaps between recorded frames of one lane are
  // not required to be contiguous. Stream 1 and the inbound lane keep their
  // own cursors.
  const ok = new RelayFrameRecorder({ session });
  ok.noteOut(ready); ok.noteOut(get); ok.noteOut(ping); ok.noteIn(credit);
  expect(verifyFrameTape(ok.toTape()).ok).toBe(true);
  const replayOk = createRelayFrameReplay(ok.toTape());
  replayOk.send(ready); replayOk.send(get); replayOk.send(ping);
  expect(Buffer.compare(Buffer.from(replayOk.recv()!), Buffer.from(credit))).toBe(0);
  expect(replayOk.result().ok).toBe(true);

  // The same frames with ping before ready: seq 3 then 1 on out/stream 0.
  const swapped = JSON.parse(stringifyFrameTape(ok.toTape())) as MutableTape;
  [swapped.frames[0], swapped.frames[2]] = [swapped.frames[2], swapped.frames[0]];
  const tape = parseFrameTape(JSON.stringify(swapped));
  const v = verifyFrameTape(tape);
  expect(v.ok).toBe(false);
  expect(v.divergence).toMatchObject({ index: 2, seq: 1, code: "order" });
  expect(v.divergence!.detail).toMatch(/out stream 0 seq 1 after seq 3/);
  const replay = createRelayFrameReplay(tape);
  replay.send(ping); replay.send(get); replay.send(ready);
  expect(replay.result().divergence).toMatchObject({ index: 2, seq: 1, code: "order" });

  // A repeated seq on one lane is an order divergence as well.
  const twice = new RelayFrameRecorder({ session });
  twice.noteOut(ping); twice.noteOut(ping);
  expect(verifyFrameTape(twice.toTape()).divergence).toMatchObject({ index: 1, code: "order" });
});
