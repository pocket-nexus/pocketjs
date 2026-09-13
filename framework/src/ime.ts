import { IME, validImeKeys, type ImeSnapshot, type ImeCandidatePage } from "../../contracts/spec/ime.ts";
import { virtualNow } from "./clock.ts";
import { offload } from "./offload.ts";
export { IME };
export type { ImeSnapshot, ImeCandidatePage };
type Channel = Pick<ReturnType<typeof offload>, "request" | "cancel" | "session">;
export type ImeState = ImeSnapshot & { pending: boolean; connected: boolean; error: string; revision: number; composing: boolean };
const empty = (): ImeSnapshot => ({ preedit: "", commit: "", candidates: [], page: 0, last: true, caret: 0, raw: "", rawCaret: 0 });

/** One editor owns one bounded transcript. A reconnect recomputes the current
 * transcript, and revision checks fence callbacks from a closed or edited field. */
export function createIme(options: {
  io?: Channel;
  now?: () => number;
  changed(state: ImeState): void;
  commit(text: string): void;
}) {
  const io = options.io ?? offload();
  let keys: number[] = [], revision = 0, request = 0, requestRevision = -1;
  let session = 0, applied = "", dirty = false, snapshot = empty(), error = "";
  let retry = 0, raw = "", rawCaret = 0, accepting = false, acceptAt = Infinity;
  const now = options.now ?? virtualNow;
  const browsing = new Set<number>(), knownCandidates = new Map<number, string>();
  function clearBrowsing() { for (const id of browsing) io.cancel(id); browsing.clear(); knownCandidates.clear(); }
  function state(): ImeState {
    const connected = io.session() > 0, fallback = !connected || !!error;
    return { ...snapshot, ...(fallback || !snapshot.preedit ? { preedit: raw, caret: rawCaret } : {}),
      raw, rawCaret, candidates: fallback ? [] : snapshot.candidates,
      pending: connected && !error && (dirty || request > 0), connected, error, revision, composing: keys.length > 0 };
  }
  const notify = () => options.changed(state());
  function finish() {
    if (!accepting) return;
    if (!io.session() || error || now() >= acceptAt) { api.commitRaw(); return; }
    if (dirty || request) return;
    if (!keys.length) { accepting = false; return; }
    if (snapshot.candidates.length) api.select(0);
    else api.commitRaw();
  }
  const api = {
    composing: () => keys.length > 0,
    state,
    /** Confirm within 400 ms of virtual time; an unavailable converter cannot
     * own the editor's lifetime. A second confirmation does not extend it. */
    accept() {
      if (!keys.length) return;
      if (!accepting) { accepting = true; acceptAt = now() + 0.4; }
      finish();
    },
    /** End the transaction before delivering local text, fencing late commits. */
    commitRaw() {
      const text = raw;
      api.reset();
      if (text) options.commit(text);
    },
    key(key: number) {
      if (!validImeKeys([key])) return false;
      if (key === IME.enter) { api.commitRaw(); return true; }
      if (keys.length >= IME.keys) { error = "Composition limit reached"; notify(); return false; }
      if (key < IME.select) { accepting = false; acceptAt = Infinity; }
      if (key >= 32 && key <= 126) {
        raw = raw.slice(0, rawCaret) + String.fromCharCode(key) + raw.slice(rawCaret); rawCaret++;
      } else if (key === IME.left) rawCaret = Math.max(0, rawCaret - 1);
      else if (key === IME.right) rawCaret = Math.min(raw.length, rawCaret + 1);
      else if (key === IME.backspace && rawCaret) {
        raw = raw.slice(0, rawCaret - 1) + raw.slice(rawCaret); rawCaret--;
      }
      if (!raw && key === IME.backspace) { api.reset(); return true; }
      clearBrowsing(); keys.push(key); revision++; dirty = true; error = "";
      // Old candidate labels are never selectable against a newer transcript.
      snapshot = { ...snapshot, candidates: [] };
      notify(); return true;
    },
    select(index: number) {
      if (!io.session() || dirty || request || index < 0 || index >= snapshot.candidates.length) return false;
      return api.key(IME.select + index);
    },
    /** A read-only window. Browsing does not change preedit or consume keys. */
    browse(offset: number, complete: (page: ImeCandidatePage | null) => void): number {
      if (dirty || request || !keys.length || io.session() <= 0 || browsing.size >= 2 ||
          !Number.isSafeInteger(offset) || offset < 0 || offset >= IME.browseLimit) return 0;
      const version = revision;
      const id = io.request("ime.candidates", JSON.stringify({ keys, offset }), result => {
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
      if (!io.session() || dirty || request || !knownCandidates.has(index)) return false;
      return api.key(IME.selectAbsolute + index);
    },
    reset() {
      clearBrowsing();
      if (request) io.cancel(request);
      request = 0; requestRevision = -1; raw = ""; rawCaret = 0; accepting = false; acceptAt = Infinity; retry = 0; revision++; keys = []; applied = ""; dirty = false; snapshot = empty(); error = ""; notify();
    },
    /** Called by the editor once per frame, after the realm offload pump. */
    step() {
      const current = io.session();
      if (current !== session) {
        clearBrowsing(); revision++;
        session = current;
        if (request) io.cancel(request);
        request = 0; dirty = keys.length > 0; retry = 0; notify();
      }
      finish();
      if (retry > 0) { retry--; return; }
      if (!dirty || request || current <= 0) return;
      const version = revision; requestRevision = version;
      request = io.request("ime.compose", JSON.stringify(keys), result => {
        if (requestRevision !== version) return;
        request = 0;
        if (revision !== version) return;
        if (!result.ok) { error = result.error; retry = 60; notify(); return; }
        try {
          const next = JSON.parse(result.value) as ImeSnapshot;
          if (typeof next.preedit !== "string" || next.preedit.length > 256 ||
              typeof next.commit !== "string" || next.commit.length > 512 ||
              !next.commit.startsWith(applied) || !Array.isArray(next.candidates) ||
              next.candidates.length > IME.candidates || next.candidates.some(c => typeof c !== "string" || c.length > 128) ||
              !Number.isSafeInteger(next.page) || next.page < 0 || !Number.isInteger(next.caret) ||
              next.caret < 0 || next.caret > next.preedit.length || typeof next.last !== "boolean") throw new Error("Invalid IME snapshot");
          if (typeof next.raw !== "string" || next.raw.length > IME.keys || !/^[\x20-\x7e]*$/.test(next.raw) ||
              !Number.isInteger(next.rawCaret) || next.rawCaret < 0 || next.rawCaret > next.raw.length)
            throw new Error("Invalid raw IME input");
          const suffix = next.commit.slice(applied.length);
          raw = next.raw; rawCaret = next.rawCaret;
          applied = next.commit; snapshot = next; dirty = false; error = "";
          next.candidates.forEach((value, i) => knownCandidates.set(next.page * IME.candidates + i, value));
          if (suffix) options.commit(suffix);
          if (!next.preedit) { keys = []; applied = ""; raw = ""; rawCaret = 0; accepting = false; snapshot = empty(); }
        } catch { error = "Invalid IME reply"; retry = 60; }
        notify();
      });
    },
    dispose() { api.reset(); },
  };
  return api;
}
