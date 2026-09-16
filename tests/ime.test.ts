import { describe, expect, test } from "bun:test";
import { createIme, IME } from "../framework/src/ime.ts";
import { createOffloadClient } from "../framework/src/offload.ts";
import type { ImeSnapshot } from "../contracts/spec/ime.ts";

function fixture() {
  let session = 1, time = 0;
  const sent: { id: number; method: string; payload: string }[] = [], replies: string[] = [], committed: string[] = [];
  const io = createOffloadClient({ session: () => session, take: () => replies.shift(),
    submit: raw => { sent.push(JSON.parse(raw)); return true; } });
  const events: string[] = [];
  const ime = createIme({ io, now: () => time, changed() {}, commit: value => { committed.push(value); events.push(`commit:${value}`); },
    edit: action => events.push(`edit:${action}`) });
  const tick = () => { time += 1 / 60; io.step(); ime.step(); };
  const answer = (request: number, fields: Partial<ImeSnapshot> = {}) => replies.push(JSON.stringify({ id: request,
    payload: JSON.stringify({ raw: (fields.preedit ?? "ni").replaceAll(" ", ""), rawCaret: (fields.preedit ?? "ni").replaceAll(" ", "").length, commit: "", preedit: "ni", candidates: ["你", "呢"], page: 0, last: false, caret: (fields.preedit ?? "ni").length, ...fields }) }));
  return { ime, io, sent, committed, events, tick, answer, replies, connect: (n: number) => { session = n; } };
}
describe("replayable IME", () => {
  test("candidate windows are reads and absolute selection is revision fenced", () => {
    const f = fixture(); f.ime.key(110); f.tick(); f.tick(); f.answer(f.sent[0].id); f.tick();
    let count = 0;
    expect(f.ime.browse(15, p => { count = p!.candidates.length; })).toBeGreaterThan(0); f.tick();
    const read = f.sent.at(-1)!;
    expect(read.method).toBe("ime.candidates");
    expect(JSON.parse(read.payload)).toEqual({ keys: [110], offset: 15 });
    f.replies.push(JSON.stringify({ id: read.id, payload: JSON.stringify({ offset: 15, candidates: ["泥", "拟"], last: true }) })); f.tick();
    expect(count).toBe(2); expect(f.ime.state().preedit).toBe("ni");
    expect(f.ime.selectAbsolute(16)).toBe(true); f.tick(); f.tick();
    expect(JSON.parse(f.sent.at(-1)!.payload)).toEqual([110, IME.selectAbsolute + 16]);
    expect(f.ime.selectAbsolute(15)).toBe(false);
  });
  test("typing cancels candidate windows and rejects their stale selections", () => {
    const f = fixture(); f.ime.key(110); f.tick(); f.tick(); f.answer(f.sent[0].id); f.tick();
    let completed = false;
    f.ime.browse(15, () => { completed = true; }); f.tick(); const old = f.sent.at(-1)!.id;
    f.ime.key(105);
    f.replies.push(JSON.stringify({ id: old, payload: JSON.stringify({ offset: 15, candidates: ["wrong"], last: true }) })); f.tick();
    expect(completed).toBe(false); expect(f.ime.selectAbsolute(15)).toBe(false);
    expect(f.ime.browse(512, () => {})).toBe(0);
  });
  test("stale candidates cannot replace a newer composition or be selected", () => {
    const f = fixture();
    f.ime.key(110); f.tick(); f.tick();
    f.ime.key(105);
    f.answer(f.sent[0].id, { preedit: "n" }); f.tick(); f.tick();
    expect(f.ime.select(0)).toBe(false);
    expect(JSON.parse(f.sent[1].payload)).toEqual([110, 105]);
    f.answer(f.sent[1].id); f.tick();
    expect(f.ime.state().preedit).toBe("ni");
    expect(f.ime.select(0)).toBe(true);
  });
  test("delayed caret replies cannot move a continuing left drag back to an older position", () => {
    const f = fixture();
    for (const ch of "haha") f.ime.key(ch.charCodeAt(0));
    f.tick(); f.tick(); f.answer(f.sent.at(-1)!.id, { preedit: "ha ha", caret: 5 }); f.tick();
    const shown = [f.ime.state().caret];
    f.ime.key(IME.left); f.tick(); f.tick(); const first = f.sent.at(-1)!.id;
    f.ime.key(IME.left);
    f.answer(first, { preedit: "ha ha", caret: 4 }); f.tick(); f.tick();
    shown.push(f.ime.state().caret);
    const second = f.sent.at(-1)!.id;
    f.answer(second, { preedit: "haha", caret: 2 }); f.tick(); shown.push(f.ime.state().caret);
    f.ime.key(IME.left); f.tick(); f.tick();
    f.answer(f.sent.at(-1)!.id, { preedit: "haha", caret: 1 }); f.tick(); shown.push(f.ime.state().caret);
    f.ime.key(IME.left); f.tick(); f.tick();
    f.answer(f.sent.at(-1)!.id, { preedit: "ha ha", caret: 0 }); f.tick(); shown.push(f.ime.state().caret);
    f.answer(first, { preedit: "ha ha", caret: 4 }); f.answer(second, { preedit: "haha", caret: 2 }); f.tick();
    shown.push(f.ime.state().caret);
    expect(shown).toEqual([5, 5, 2, 1, 0, 0]);
    expect(JSON.parse(f.sent.at(-1)!.payload)).toEqual([...Array.from("haha", c => c.charCodeAt(0)), ...Array(4).fill(IME.left)]);
    expect(f.committed).toEqual([]);
  });
  test("disconnect retains the transcript and fences replies from its previous transport", () => {
    const f = fixture();
    f.ime.key(110); f.tick(); f.tick();
    const old = f.sent[0].id;
    f.connect(0); f.tick(); f.ime.key(105); f.tick();
    expect(f.ime.state().connected).toBe(false);
    f.connect(2); f.tick(); f.tick();
    expect(JSON.parse(f.sent[1].payload)).toEqual([110, 105]);
    f.answer(old, { commit: "wrong", preedit: "" }); f.tick();
    expect(f.committed).toEqual([]);
    f.answer(f.sent[1].id); f.tick();
    expect(f.ime.select(1)).toBe(true);
    f.tick(); f.tick();
    f.answer(f.sent[2].id, { commit: "呢", preedit: "", candidates: [] }); f.tick();
    expect(f.committed).toEqual(["呢"]);
    expect(f.ime.composing()).toBe(false);
  });
  test("closing an editor rejects in-flight commits; transcript budget is bounded", () => {
    const f = fixture(); f.ime.key(110); f.tick(); f.tick();
    f.ime.reset(); f.answer(f.sent[0].id, { commit: "你", preedit: "" }); f.tick();
    expect(f.committed).toEqual([]);
    for (let i = 0; i < IME.keys; i++) expect(f.ime.key(97)).toBe(true);
    expect(f.ime.key(97)).toBe(false);
    f.ime.reset();
    expect(f.ime.key(-1)).toBe(false);
    expect(f.ime.key(0x1f600)).toBe(false);
    expect(f.ime.key(97)).toBe(true);
  });
});

test("offline input remains visible, editable and locally committable", () => {
  const f = fixture(); f.connect(0); f.tick();
  for (const ch of "nihao") f.ime.key(ch.charCodeAt(0));
  expect(f.ime.state().preedit).toBe("nihao");
  expect(f.ime.state().pending).toBe(false);
  f.ime.key(IME.left); f.ime.key(IME.backspace); f.ime.key(120);
  expect(f.ime.state().preedit).toBe("nihxo"); expect(f.ime.state().caret).toBe(4);
  f.ime.accept();
  expect(f.committed).toEqual(["nihxo"]); expect(f.ime.composing()).toBe(false);
  f.connect(2); for (let i = 0; i < 5; i++) f.tick();
  expect(f.sent).toHaveLength(0); expect(f.committed).toEqual(["nihxo"]);
});

test("confirmation has a deadline even when a connected provider never answers", () => {
  const f = fixture(); for (const ch of "ni") f.ime.key(ch.charCodeAt(0));
  f.tick(); f.tick(); const old = f.sent.at(-1)!.id;
  f.ime.accept();
  for (let i = 0; i < 12; i++) f.tick();
  f.ime.accept(); // repeated Return cannot extend the first deadline
  for (let i = 0; i < 14; i++) f.tick();
  expect(f.committed).toEqual(["ni"]); expect(f.ime.composing()).toBe(false);
  f.answer(old, { preedit: "", commit: "你" }); f.tick();
  f.ime.key(104); f.tick(); f.tick();
  expect(JSON.parse(f.sent.at(-1)!.payload)).toEqual([104]);
  expect(f.committed).toEqual(["ni"]);
});

test("disconnect during candidate confirmation commits raw text once", () => {
  const f = fixture(); for (const ch of "ni") f.ime.key(ch.charCodeAt(0));
  f.tick(); f.tick(); f.answer(f.sent.at(-1)!.id); f.tick(); f.ime.accept(); f.tick(); f.tick();
  const old = f.sent.at(-1)!.id;
  f.connect(0); f.tick();
  expect(f.committed).toEqual(["ni"]);
  f.connect(2); f.tick(); f.answer(old, { preedit: "", commit: "你" }); f.tick();
  expect(f.committed).toEqual(["ni"]); expect(f.ime.composing()).toBe(false);
});

test("raw snapshot excludes committed prefixes and preserves apostrophes and caret", () => {
  const f = fixture(); f.ime.key(110); f.tick(); f.tick();
  f.answer(f.sent.at(-1)!.id, { commit: "你", preedit: "xi an", raw: "xi'an", rawCaret: 2, caret: 2 }); f.tick();
  f.connect(0); f.tick(); f.ime.key(IME.backspace); f.ime.commitRaw();
  expect(f.committed).toEqual(["你", "x'an"]);
  f.connect(2); f.tick(); f.tick(); expect(f.sent).toHaveLength(1);
});

test("deleting the final offline letter ends composition; a full transcript can still commit", () => {
  const f = fixture(); f.connect(0); f.tick(); f.ime.key(110); f.ime.key(IME.backspace);
  expect(f.ime.composing()).toBe(false);
  for (let i = 0; i < IME.keys; i++) f.ime.key(97);
  expect(f.ime.key(98)).toBe(false); f.ime.accept();
  expect(f.committed).toEqual(["a".repeat(IME.keys)]);
});

test("provider failure and invalid raw data cannot block local confirmation", () => {
  for (const invalid of [false, true]) {
    const f = fixture(); f.ime.key(110); f.tick(); f.tick();
    if (invalid) f.answer(f.sent.at(-1)!.id, { rawCaret: 200 });
    else f.replies.push(JSON.stringify({ id: f.sent.at(-1)!.id, error: "engine unavailable" }));
    f.tick(); expect(f.ime.state().error).not.toBe(""); f.ime.accept();
    expect(f.committed).toEqual(["n"]);
  }
});

test("confirmation freezes its input boundary while following keys wait in order", () => {
  const f = fixture(); for (const ch of "ni") f.ime.key(ch.charCodeAt(0));
  f.tick(); f.tick(); const first = f.sent.at(-1)!.id;
  f.ime.accept(); for (const ch of "hao") f.ime.key(ch.charCodeAt(0));
  f.answer(first); f.tick(); f.tick();
  expect(JSON.parse(f.sent.at(-1)!.payload)).toEqual([110, 105, IME.select]);
  f.answer(f.sent.at(-1)!.id, { commit: "你", preedit: "", candidates: [] }); f.tick(); f.tick();
  expect(f.committed).toEqual(["你"]);
  expect(JSON.parse(f.sent.at(-1)!.payload)).toEqual([104, 97, 111]);
  f.answer(f.sent.at(-1)!.id, { preedit: "hao", candidates: ["好"] }); f.tick();
  expect(f.ime.state().raw).toBe("hao"); expect(f.ime.composing()).toBe(true);
});

test("typing after confirmation cannot move or cancel its fallback deadline", () => {
  const f = fixture(); for (const ch of "ni") f.ime.key(ch.charCodeAt(0));
  f.tick(); f.tick(); const old = f.sent.at(-1)!.id; f.ime.accept();
  for (let i = 0; i < 12; i++) f.tick();
  for (const ch of "hao") f.ime.key(ch.charCodeAt(0));
  for (let i = 0; i < 14; i++) f.tick();
  expect(f.committed).toEqual(["ni"]); expect(f.ime.state().raw).toBe("hao");
  f.answer(old, { commit: "wrong", preedit: "" }); f.tick(); expect(f.committed).toEqual(["ni"]);
  f.connect(0); f.tick(); f.ime.accept(); expect(f.committed).toEqual(["ni", "hao"]);
});

test("queued confirmations keep their order and deadlines across disconnect and reset", () => {
  const f = fixture(); for (const ch of "ni") f.ime.key(ch.charCodeAt(0)); f.ime.accept();
  for (const ch of "hao") f.ime.key(ch.charCodeAt(0)); f.ime.accept();
  f.ime.key(97); f.tick(); f.tick(); const old = f.sent.at(-1)!.id;
  f.connect(0); f.tick();
  expect(f.committed).toEqual(["ni", "hao"]); expect(f.ime.state().raw).toBe("a");
  f.ime.reset(); f.connect(2); f.answer(old, { commit: "wrong", preedit: "" }); f.tick();
  expect(f.committed).toEqual(["ni", "hao"]); expect(f.ime.composing()).toBe(false);
});

test("mode-switch raw commit drains confirmed and current input in source order", () => {
  const f = fixture(); for (const ch of "ni") f.ime.key(ch.charCodeAt(0)); f.ime.accept();
  for (const ch of "hao") f.ime.key(ch.charCodeAt(0)); f.ime.key(IME.left); f.ime.key(IME.backspace);
  f.ime.commitRaw(); expect(f.committed.join("")).toBe("niho"); expect(f.ime.composing()).toBe(false);
});


test("committed-text deletion and caret edits wait behind a confirmed prefix", () => {
  const f = fixture(); for (const ch of "ni") f.ime.key(ch.charCodeAt(0));
  f.tick(); f.tick(); f.answer(f.sent.at(-1)!.id); f.tick(); f.ime.accept();
  f.ime.key(IME.backspace); f.ime.key(IME.left); for (const ch of "hao") f.ime.key(ch.charCodeAt(0));
  f.tick(); f.tick(); f.answer(f.sent.at(-1)!.id, { preedit: "", commit: "你", candidates: [] }); f.tick(); f.tick();
  expect(f.events).toEqual(["commit:你", "edit:backspace", "edit:left"]);
  expect(JSON.parse(f.sent.at(-1)!.payload)).toEqual([104, 97, 111]);
  expect(f.ime.state().raw).toBe("hao");
});

test("the action budget covers every queued segment and committed-text edit", () => {
  const f = fixture();
  for (let i = 0; i < IME.keys / 2; i++) { expect(f.ime.key(97)).toBe(true); f.ime.accept(); expect(f.ime.key(IME.left)).toBe(true); }
  expect(f.ime.key(98)).toBe(false);
  f.ime.commitRaw(); expect(f.events).toHaveLength(IME.keys);
  expect(f.events.slice(0, 4)).toEqual(["commit:a", "edit:left", "commit:a", "edit:left"]);
  expect(f.ime.composing()).toBe(false);
});
