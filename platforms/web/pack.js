// platforms/web/pack.js — the browser host's implementation of the pack module
// (contracts/spec/pack.ts). open() cannot block on the network, so the first
// open of a path starts a fetch and returns PACK_OPEN_PENDING (-2); the guest
// calls open() again on a later frame and gets a handle once the bytes are
// here. A file lives in one ArrayBuffer from that fetch until its last handle
// closes; a later open fetches it again (the HTTP cache answers).
//
// Mount before the bundle evaluates, beside `globalThis.audio`:
//   const packHost = createPackHost({ baseUrl: "/packs/", ops: wasm });
//   globalThis.pack = packHost.ns;

/** Must equal PACK_MAX_* and PACK_OPEN_* in contracts/spec/pack.ts. */
const OPEN_MISSING = -1;
const OPEN_PENDING = -2;
const MAX_HANDLES = 8;
const MAX_IMG_BYTES = 1114112;
const MAX_PATH_BYTES = 200;
const MAX_SEGMENT_BYTES = 64;
const MAX_DEPTH = 8;

const encoder = new TextEncoder();
const utf8Bytes = (text) => encoder.encode(text).length;

/** packValidPath in contracts/spec/pack.ts. */
function validPath(path) {
  if (typeof path !== "string" || path.length === 0 || utf8Bytes(path) > MAX_PATH_BYTES) return false;
  if (path.includes(":") || path.includes("\\")) return false;
  const segments = path.split("/");
  if (segments.length > MAX_DEPTH) return false;
  return segments.every((s) => s.length > 0 && s !== "." && s !== ".." && utf8Bytes(s) <= MAX_SEGMENT_BYTES);
}

/**
 * @param {{ baseUrl: string, ops?: object | null, fetch?: typeof fetch }} options
 *   baseUrl: the game data root as a URL prefix.
 *   ops: the receiver of loadImg's bytes: the object createWasmUi returns (its
 *   `ops` change at boot, so they are read at each call) or any object with
 *   uploadImgEntry. Absent: `globalThis.ui`.
 */
export function createPackHost({ baseUrl, ops = null, fetch: fetchImpl }) {
  const prefix = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const load = fetchImpl ?? ((url) => globalThis.fetch(url));
  /** path -> { state: "pending" | "ready" | "missing", bytes, refs } */
  const files = new Map();
  /** handle -> the file record */
  const handles = new Map();
  const uploader = () => {
    if (ops?.uploadImgEntry) return ops;
    if (ops?.ops?.uploadImgEntry) return ops.ops;
    return globalThis.ui?.uploadImgEntry ? globalThis.ui : null;
  };
  let nextHandle = 0;
  let epoch = 0;
  const stats = {
    opens: 0, reads: 0, readBytes: 0, loadImgs: 0,
    readUsLast: 0, readUsMax: 0, readUsSum: 0, loadImgUsLast: 0, loadImgUsMax: 0, loadImgUsSum: 0,
    readBufBytes: 0, root: "",
  };

  function startFetch(path) {
    const record = { state: "pending", bytes: null, refs: 0 };
    files.set(path, record);
    const started = epoch;
    const url = prefix + path.split("/").map(encodeURIComponent).join("/");
    Promise.resolve()
      .then(() => load(url))
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        if (started !== epoch) return;
        record.bytes = new Uint8Array(buffer);
        record.state = "ready";
      })
      .catch((error) => {
        if (started !== epoch) return;
        record.state = "missing";
        console.warn(`pack: ${path}: ${error}`);
      });
  }

  const ns = {
    open(path) {
      if (!validPath(path)) return OPEN_MISSING;
      const record = files.get(path);
      if (!record) {
        startFetch(path);
        return OPEN_PENDING;
      }
      if (record.state === "pending") return OPEN_PENDING;
      if (record.state === "missing") {
        files.delete(path); // a later open tries the network again
        return OPEN_MISSING;
      }
      if (handles.size >= MAX_HANDLES) return OPEN_MISSING;
      const handle = nextHandle++;
      record.refs++;
      handles.set(handle, { path, record });
      stats.opens++;
      stats.root = "url";
      return handle;
    },
    size(handle) {
      const open = handles.get(handle);
      return open ? open.record.bytes.length : -1;
    },
    read(handle, offset, dst) {
      const open = handles.get(handle);
      if (!open || !(offset >= 0) || !(dst instanceof Uint8Array)) return -1;
      const bytes = open.record.bytes;
      const start = Math.min(offset, bytes.length);
      const count = Math.min(dst.length, bytes.length - start);
      dst.set(bytes.subarray(start, start + count));
      stats.reads++;
      stats.readBytes += count;
      return count;
    },
    loadImg(handle, offset, length) {
      const open = handles.get(handle);
      const target = uploader();
      if (!open || !target) return -1;
      const bytes = open.record.bytes;
      if (!(offset >= 0) || !(length >= 8) || length > MAX_IMG_BYTES || offset + length > bytes.length) return -1;
      const started = performance.now();
      const texture = target.uploadImgEntry(bytes.subarray(offset, offset + length));
      const us = Math.round((performance.now() - started) * 1000);
      stats.loadImgs++;
      stats.loadImgUsLast = us;
      stats.loadImgUsMax = Math.max(stats.loadImgUsMax, us);
      stats.loadImgUsSum += us;
      return texture;
    },
    close(handle) {
      const open = handles.get(handle);
      if (!open) return;
      handles.delete(handle);
      if (--open.record.refs === 0) files.delete(open.path);
    },
    stats() {
      return JSON.stringify(stats);
    },
  };

  return {
    ns,
    /** Fresh app load: close every handle, forget every file. A fetch still
     *  in flight lands in a dropped record. */
    reset() {
      epoch++;
      handles.clear();
      files.clear();
    },
  };
}
