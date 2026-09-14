/** Run after ime:setup; this gate uses the deployed dictionary and native engine. */
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { RimeEngine } from "./rime.ts";
import { createIme } from "../../framework/src/ime.ts";
import { createOffloadClient } from "../../framework/src/offload.ts";
import { IME } from "../../contracts/spec/ime.ts";
const engine = new RimeEngine(resolve(Bun.argv[2] ?? ".pocket/ime"));
const keys = (s: string) => Array.from(s, c => c.charCodeAt(0));
const compose = async (input: number[]) => JSON.parse(await engine.compose(JSON.stringify(input)));
try {
  for (const [pinyin, expected] of [["nihao", "你好"], ["zhongwen", "中文"], ["beijing", "北京"]]) {
    const input = keys(pinyin);
    const snapshot = await compose(input);
    assert.equal(snapshot.candidates[0], expected);
    assert.equal(snapshot.raw, pinyin); assert.equal(snapshot.rawCaret, pinyin.length);
    const committed = await compose([...input, IME.select]);
    assert.equal(committed.commit, expected);
    assert.equal(committed.preedit, "");
    assert.equal(committed.raw, ""); assert.equal(committed.rawCaret, 0);
    assert.deepEqual(await compose([...input, IME.select]), committed);
  }
  const first = await compose(keys("ni"));
  const browse = async (offset: number) => JSON.parse(await engine.compose(JSON.stringify({ keys: keys("ni"), offset }), true));
  const window = await browse(0), later = await browse(15);
  assert.deepEqual(window.candidates.slice(0, 5), first.candidates);
  assert.equal(window.candidates.length, 15); assert.equal(window.last, false);
  assert.equal(later.offset, 15); assert.ok(later.candidates.length > 0);
  assert.equal((await compose([...keys("ni"), IME.selectAbsolute + 15])).commit, later.candidates[0]);
  assert.deepEqual(await compose(keys("ni")), first);
  const second = await compose([...keys("ni"), IME.pageDown]);
  assert.equal(second.page, 1);
  assert.notDeepEqual(second.candidates, first.candidates);
  assert.deepEqual(await compose([...keys("ni"), IME.pageDown, IME.pageUp]), first);
  assert.deepEqual(await compose([...keys("nix"), IME.backspace]), first);
  const moved = await compose([...keys("nihao"), IME.left]);
  assert.ok(moved.caret < moved.preedit.length);
  for (const word of ["haha", "nihao", "xi'an"]) {
    const transcript = keys(word), original = await compose(transcript);
    let previous = original;
    for (let step = 0; step < word.length + 4; step++) {
      transcript.push(IME.left);
      const next = await compose(transcript);
      assert.ok(next.caret <= previous.caret, `${word}: Left moved right at step ${step}`);
      if (step < word.length) assert.ok(next.caret < previous.caret, `${word}: Left must move one input character`);
      assert.equal(next.commit, "");
      assert.equal(next.raw, word);
      previous = next;
    }
    assert.equal(previous.caret, 0);
    for (let step = 0; step < word.length + 4; step++) {
      transcript.push(IME.right);
      const next = await compose(transcript);
      assert.ok(next.caret >= previous.caret, `${word}: Right moved left at step ${step}`);
      if (step < word.length) assert.ok(next.caret > previous.caret, `${word}: Right must move one input character`);
      assert.equal(next.commit, "");
      assert.equal(next.raw, word);
      previous = next;
    }
    assert.deepEqual(previous, original);
    assert.deepEqual(await compose(transcript), previous);
    assert.equal((await compose([...transcript, IME.enter])).commit, word);
  }
  const toEnd = Array(8).fill(IME.right);
  assert.equal((await compose([...keys("haha"), IME.left, IME.left, 120, ...toEnd, IME.enter])).commit, "haxha");
  assert.equal((await compose([...keys("haha"), IME.left, IME.backspace, ...toEnd, IME.enter])).commit, "haa");
  assert.deepEqual(await compose([IME.left, IME.right]), await compose([]));
  assert.equal((await compose([...keys("nihao"), IME.enter])).commit, "nihao");
  assert.equal((await compose([...keys("nihao"), 32])).commit, "你好");
  // Exercise the guest state machine against real conversion, holding every
  // response for three frames while both confirmed words arrive beforehand.
  let frame = 0;
  const pending: { id: number; payload: string; at: number }[] = [], replies: string[] = [], committed: string[] = [];
  const transcripts: number[][] = [];
  const io = createOffloadClient({ session: () => 1, take: () => replies.shift(), submit(raw) {
    const request = JSON.parse(raw); pending.push({ ...request, at: frame + 3 });
    transcripts.push(JSON.parse(request.payload)); return true;
  } });
  const ime = createIme({ io, now: () => frame / 60, changed() {}, commit: text => committed.push(text) });
  for (const ch of "ni") ime.key(ch.charCodeAt(0)); ime.accept();
  for (const ch of "hao") ime.key(ch.charCodeAt(0)); ime.accept();
  ime.key(97);
  for (frame = 1; frame <= 35; frame++) {
    while (pending[0]?.at <= frame) {
      const request = pending.shift()!;
      replies.push(JSON.stringify({ id: request.id, payload: await engine.compose(request.payload) }));
    }
    io.step(); ime.step();
  }
  assert.deepEqual(committed, ["你", "好"]);
  assert.equal(ime.state().raw, "a");
  assert.deepEqual(transcripts, [keys("ni"), [...keys("ni"), IME.select], keys("hao"), [...keys("hao"), IME.select], keys("a")]);
  ime.commitRaw(); assert.deepEqual(committed, ["你", "好", "a"]); ime.dispose(); io.dispose();
  console.log("Rime acceptance passed: phrases, selection, replay, paging, read-only windows, absolute selection, deletion, bounded character caret, raw commit, space, ordered guest confirmations under delayed replies");
} finally { engine.close(); }
