import { IME, validImeKeys, type ImeSnapshot, type ImeCandidatePage } from "../../contracts/spec/ime.ts";
import { virtualNow } from "./clock.ts";
import { offload } from "./offload.ts";
export { IME };
export type { ImeSnapshot, ImeCandidatePage };
type Channel = Pick<ReturnType<typeof offload>, "request" | "cancel" | "session">;
export type ImeState = ImeSnapshot & { pending: boolean; connected: boolean; error: string; revision: number; composing: boolean };
const empty = (): ImeSnapshot => ({ preedit: "", commit: "", candidates: [], page: 0, last: true, caret: 0, raw: "", rawCaret: 0 });
export type ImeEdit = "backspace" | "left" | "right";
type Composition = {
  edit?: ImeEdit;
  keys: number[]; raw: string; caret: number; snapshot: ImeSnapshot; applied: string;
  version: number; dirty: boolean; error: string; retry: number; confirmAt?: number;
};
const composition = (): Composition => ({ keys: [], raw: "", caret: 0, snapshot: empty(), applied: "",
  version: 0, dirty: false, error: "", retry: 0 });

/** Confirmed segments form an ordered queue; only its head talks to the
 * converter. Later typing edits the tail without changing a sealed prefix.
 * The entire queue shares one action budget and one in-flight compose read. */
export function createIme(options: {
  io?: Channel;
  now?: () => number;
  changed(state: ImeState): void;
  commit(text: string): void;
  /** Committed-text edits ordered after any preceding confirmation. */
  edit?(action: ImeEdit): void;
}) {
  const io = options.io ?? offload(), now = options.now ?? virtualNow;
  const queue: Composition[] = [];
  let revision = 0, request = 0, requestSerial = 0, session = 0, budgetError = "";
  const browsing = new Set<number>(), knownCandidates = new Map<number, string>();
  const tail = () => queue.at(-1);
  const keyCount = () => queue.reduce((count, item) => count + item.keys.length, 0);
  function clearBrowsing() { for (const id of browsing) io.cancel(id); browsing.clear(); knownCandidates.clear(); }
  function cancelRequest() { if (request) io.cancel(request); request = 0; requestSerial++; }
  function changed() { revision++; clearBrowsing(); budgetError = ""; }
  function state(): ImeState {
    const item = tail(), connected = io.session() > 0, error = budgetError || item?.error || "";
    const snapshot = item?.snapshot ?? empty(), raw = item?.raw ?? "", rawCaret = item?.caret ?? 0;
    const fallback = !connected || !!error;
    return { ...snapshot, ...(fallback || !snapshot.preedit ? { preedit: raw, caret: rawCaret } : {}), raw, rawCaret,
      candidates: fallback || item?.confirmAt !== undefined ? [] : snapshot.candidates,
      pending: connected && !error && (queue.length > 1 || !!item?.dirty || request > 0),
      connected, error, revision, composing: queue.length > 0 };
  }
  const notify = () => options.changed(state());
  function removeHead() { cancelRequest(); queue.shift(); changed(); }
  function commitHeadRaw() {
    const text = queue[0].raw;
    removeHead();
    if (text) options.commit(text);
    notify();
  }
  function append(item: Composition, key: number) {
    item.keys.push(key); item.version++; item.dirty = true; item.error = "";
    item.snapshot = { ...item.snapshot, candidates: [] }; changed();
  }
  function confirm(item: Composition) { item.confirmAt ??= now() + 0.4; changed(); }
  function finish() {
    // The loop is bounded by the shared 128-action queue. Removing one expired
    // prefix must never commit or discard an unconfirmed suffix.
    while (queue.length) {
      const head = queue[0];
      if (head.edit) {
        removeHead(); options.edit?.(head.edit); notify(); continue;
      }
      if (head.confirmAt === undefined) return;
      if (!io.session() || head.error || now() >= head.confirmAt) { commitHeadRaw(); continue; }
      if (head.dirty || request) return;
      if (!head.snapshot.candidates.length || keyCount() >= IME.keys) { commitHeadRaw(); continue; }
      append(head, IME.select); notify(); return;
    }
  }
  function selectable() {
    return queue.length === 1 && !queue[0].edit && queue[0].confirmAt === undefined && !queue[0].dirty && !request && io.session() > 0;
  }
  const api = {
    composing: () => queue.length > 0,
    state,
    /** Seal this input boundary. Further typing and repeated confirmation do
     * not cancel or extend its 400 ms virtual-time fallback deadline. */
    accept() {
      const item = tail();
      if (!item || item.edit || item.confirmAt !== undefined) return;
      confirm(item); finish(); notify();
    },
    /** Mode changes drain every segment in order and fence remote commits. */
    commitRaw() {
      const pending = queue.slice();
      api.reset();
      for (const item of pending) {
        if (item.edit) options.edit?.(item.edit);
        else if (item.raw) options.commit(item.raw);
      }
    },
    key(key: number) {
      if (!validImeKeys([key])) return false;
      if (key === IME.enter) { api.commitRaw(); return true; }
      if (keyCount() >= IME.keys) { budgetError = "Composition limit reached"; notify(); return false; }
      let item = tail();
      if (!item || item.edit || item.confirmAt !== undefined) {
        const edit = key === IME.backspace ? "backspace" : key === IME.left ? "left" : key === IME.right ? "right" : undefined;
        if (edit && !options.edit) return false;
        item = composition(); item.edit = edit; queue.push(item);
        if (edit) { append(item, key); finish(); notify(); return true; }
      }
      if (key >= 32 && key <= 126) {
        item.raw = item.raw.slice(0, item.caret) + String.fromCharCode(key) + item.raw.slice(item.caret); item.caret++;
      } else if (key === IME.left) item.caret = Math.max(0, item.caret - 1);
      else if (key === IME.right) item.caret = Math.min(item.raw.length, item.caret + 1);
      else if (key === IME.backspace && item.caret) {
        item.raw = item.raw.slice(0, item.caret - 1) + item.raw.slice(item.caret); item.caret--;
      }
      if (!item.raw && key === IME.backspace) {
        if (queue[0] === item) cancelRequest();
        queue.pop(); changed(); notify(); return true;
      }
      append(item, key); notify(); return true;
    },
    select(index: number) {
      if (!selectable() || !Number.isInteger(index) || index < 0 || index >= queue[0].snapshot.candidates.length) return false;
      if (!api.key(IME.select + index)) return false;
      confirm(queue[0]); notify(); return true;
    },
    /** A read-only window. Browsing does not change preedit or consume keys. */
    browse(offset: number, complete: (page: ImeCandidatePage | null) => void): number {
      if (!selectable() || browsing.size >= 2 || !Number.isSafeInteger(offset) || offset < 0 || offset >= IME.browseLimit) return 0;
      const version = revision;
      const id = io.request("ime.candidates", JSON.stringify({ keys: queue[0].keys, offset }), result => {
        browsing.delete(id);
        if (version !== revision) return;
        if (result.ok) try {
          const page = JSON.parse(result.value) as ImeCandidatePage;
          if (page.offset !== offset || !Array.isArray(page.candidates) || page.candidates.length > IME.browseSize ||
              offset + page.candidates.length > IME.browseLimit || typeof page.last !== "boolean" ||
              page.candidates.some(c => typeof c !== "string" || c.length > 128) || (!page.last && !page.candidates.length)) throw new Error();
          page.candidates.forEach((value, i) => knownCandidates.set(offset + i, value));
          complete(page); return;
        } catch { /* Invalid windows never enter the selectable set. */ }
        complete(null);
      });
      if (id) browsing.add(id);
      return id;
    },
    selectAbsolute(index: number) {
      if (!selectable() || !knownCandidates.has(index)) return false;
      if (!api.key(IME.selectAbsolute + index)) return false;
      confirm(queue[0]); notify(); return true;
    },
    reset() { cancelRequest(); queue.length = 0; changed(); notify(); },
    /** Called by the editor once per frame, after the realm offload pump. */
    step() {
      const current = io.session();
      if (current !== session) {
        session = current; cancelRequest(); changed();
        for (const item of queue) { item.dirty = true; item.retry = 0; }
        notify();
      }
      finish();
      const head = queue[0];
      if (!head) return;
      if (head.retry > 0) { head.retry--; return; }
      if (!head.dirty || request || current <= 0) return;
      const version = head.version, serial = ++requestSerial;
      request = io.request("ime.compose", JSON.stringify(head.keys), result => {
        if (serial !== requestSerial) return;
        request = 0;
        if (queue[0] !== head || head.version !== version || io.session() !== current) return;
        if (!result.ok) { head.error = result.error; head.retry = 60; notify(); return; }
        let next: ImeSnapshot;
        try {
          next = JSON.parse(result.value) as ImeSnapshot;
          if (typeof next.preedit !== "string" || next.preedit.length > 256 ||
              typeof next.commit !== "string" || next.commit.length > 512 ||
              !next.commit.startsWith(head.applied) || !Array.isArray(next.candidates) ||
              next.candidates.length > IME.candidates || next.candidates.some(c => typeof c !== "string" || c.length > 128) ||
              !Number.isSafeInteger(next.page) || next.page < 0 || !Number.isInteger(next.caret) ||
              next.caret < 0 || next.caret > next.preedit.length || typeof next.last !== "boolean" ||
              typeof next.raw !== "string" || next.raw.length > IME.keys || !/^[\x20-\x7e]*$/.test(next.raw) ||
              !Number.isInteger(next.rawCaret) || next.rawCaret < 0 || next.rawCaret > next.raw.length) throw new Error();
        } catch { head.error = "Invalid IME reply"; head.retry = 60; notify(); return; }
        const suffix = next.commit.slice(head.applied.length);
        head.raw = next.raw; head.caret = next.rawCaret; head.applied = next.commit;
        head.snapshot = next; head.dirty = false; head.error = "";
        if (!next.preedit) removeHead();
        else if (selectable()) next.candidates.forEach((value, i) => knownCandidates.set(next.page * IME.candidates + i, value));
        if (suffix) options.commit(suffix);
        notify();
      });
    },
    dispose() { api.reset(); },
  };
  return api;
}
