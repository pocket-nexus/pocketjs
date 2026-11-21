/** Experimental portable text layout over the framework io.offload contract.
 * No synchronous layout fallback: incapable hosts must pair a companion.
 * Uploads and result pages are bounded and advance only at frame boundaries. */
import { offload, type OffloadOps } from "./offload.ts";
import { registerServicePump } from "./services.ts";
export const TEXT_LAYOUT = Object.freeze({
  version: 1,
  maxDocument: 65536,
  chunkUnits: 512,
  inlineUnits: 2048,
  pageRows: 32,
  maxRows: 4096,
});
export interface TextRow {
  row: number;
  from: number;
  to: number;
}
export type TextLayoutState =
  | { status: "companion-required" | "pending"; revision: number }
  | { status: "error"; revision: number; error: string }
  | { status: "ready"; revision: number; rows: TextRow[] };
export function textLayoutAvailable(): boolean {
  return (
    ((globalThis as unknown as { offload?: OffloadOps }).offload?.session() ??
      0) > 0
  );
}
let nextKey = 0;
function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code < 128 ? 1 : code < 2048 ? 2 : code < 65536 ? 3 : 4;
  }
  return bytes;
}
function fitsRecord(data: Record<string, unknown>): boolean {
  const payload = JSON.stringify(data);
  return payload.length <= 2500 && utf8Length(JSON.stringify(payload)) <= 3900;
}
function editRange(before: string, after: string) {
  let from = 0,
    to = before.length,
    end = after.length;
  while (from < to && from < end && before[from] === after[from]) from++;
  if (from > 0 && /[\uD800-\uDBFF]/.test(before[from - 1])) from--;
  while (to > from && end > from && before[to - 1] === after[end - 1]) {
    to--;
    end--;
  }
  if (to < before.length && /[\uDC00-\uDFFF]/.test(before[to])) {
    to++;
    end++;
  }
  return { from, to, text: after.slice(from, end) };
}
/** One independently revisioned document. Replacing input cancels delivery of
 * superseded work; provider revisions additionally fence already-sent writes. */
export function createTextLayout(changed: (state: TextLayoutState) => void) {
  const key = `text-${++nextKey}`;
  let revision = 0,
    source = "",
    slot = 0,
    width: number | null = null;
  let stage:
    "idle" | "replace" | "edit" | "open" | "append" | "layout" | "close" =
    "idle";
  let resident: { source: string; revision: number } | undefined;
  let inline: Record<string, unknown> | undefined;
  let offset = 0,
    page = 0,
    request = 0,
    session = 0,
    disposed = false,
    needsLayout = false;
  let rows: TextRow[] = [],
    sourceLines: string[] = [],
    client: ReturnType<typeof offload> | undefined;
  const fail = (error: string) => {
    resident = undefined;
    stage = "idle";
    changed({ status: "error", revision, error });
  };
  const removePump = registerServicePump(() => {
    const ops = (globalThis as unknown as { offload?: OffloadOps }).offload;
    if (!ops || ops.session() <= 0) {
      if (stage !== "idle" && session !== 0) {
        session = 0;
        changed({ status: "companion-required", revision });
      }
      return;
    }
    client ??= offload();
    if (session !== client.session()) {
      resident = undefined;
      session = client.session();
      if (request) client.cancel(request);
      request = 0;
      if (needsLayout && !disposed) {
        stage = chooseUpload();
        offset = 0;
        page = 0;
        rows = [];
        changed({ status: "pending", revision });
      }
    }
    if (stage === "idle" || request) return;
    const currentRevision = revision,
      currentStage = stage;
    let method: string,
      data: Record<string, unknown> = { key, revision };
    if (stage === "replace" || stage === "edit") {
      method = `text.${stage}`;
      data = inline!;
    } else if (stage === "open") {
      method = "text.open";
      Object.assign(data, { slot, width, length: source.length });
    } else if (stage === "append") {
      method = "text.append";
      let end = Math.min(source.length, offset + TEXT_LAYOUT.chunkUnits);
      // A frame boundary must never split a surrogate pair.
      for (;;) {
        if (
          end < source.length &&
          source.charCodeAt(end - 1) >= 0xd800 &&
          source.charCodeAt(end - 1) <= 0xdbff
        )
          end--;
        Object.assign(data, {
          offset,
          text: source.slice(offset, end),
          layout: end === source.length,
        });
        // Control characters are escaped twice by the JSON envelope. Reserve
        // space for its method/id and shrink only pathological chunks.
        if (fitsRecord(data)) break;
        end = offset + Math.max(2, Math.floor((end - offset) / 2));
      }
    } else if (stage === "layout") {
      method = "text.layout";
      data.offset = page;
    } else method = "text.close";
    request = client.request(method, JSON.stringify(data), (result) => {
      request = 0;
      if (revision !== currentRevision) return;
      if (currentStage === "close") {
        stage = "idle";
        removePump();
        return;
      }
      if (!result.ok) {
        fail(result.error);
        return;
      }
      try {
        const value = JSON.parse(result.value);
        if (
          currentStage === "open" ||
          (currentStage === "append" && !data.layout)
        ) {
          if (
            !Number.isInteger(value.offset) ||
            value.offset !==
              (currentStage === "open"
                ? 0
                : offset + (data.text as string).length)
          )
            throw Error("Invalid upload acknowledgement");
          offset = value.offset;
          stage = offset === source.length ? "layout" : "append";
        } else {
          if (
            value.revision !== revision ||
            !Array.isArray(value.rows) ||
            value.rows.length > TEXT_LAYOUT.pageRows ||
            !Number.isInteger(value.total) ||
            value.total < 1 ||
            value.total > TEXT_LAYOUT.maxRows
          )
            throw Error("Invalid layout page");
          let previous = rows[rows.length - 1];
          for (const row of value.rows) {
            const line = sourceLines[row.row];
            const continues = previous && row.row === previous.row;
            if (
              ![row.row, row.from, row.to].every(Number.isSafeInteger) ||
              row.row < 0 ||
              typeof line !== "string" ||
              row.from < 0 ||
              row.to < row.from ||
              row.to > line.length ||
              row.row !==
                (previous
                  ? continues
                    ? previous.row
                    : previous.row + 1
                  : 0) ||
              row.from !== (continues ? previous!.to : 0) ||
              (!continues &&
                previous &&
                previous.to !== sourceLines[previous.row].length) ||
              (row.from === row.to && (line.length !== 0 || continues)) ||
              (row.to < line.length && /[\uDC00-\uDFFF]/.test(line[row.to]))
            )
              throw Error("Invalid layout row");
            previous = row;
          }
          if (
            rows.length + value.rows.length > value.total ||
            (value.next !== null &&
              value.next !== rows.length + value.rows.length)
          )
            throw Error("Invalid layout continuation");
          rows.push(...value.rows);
          if (value.next === null) {
            const last = rows[rows.length - 1];
            if (
              rows.length !== value.total ||
              last?.row !== sourceLines.length - 1 ||
              last.to !== sourceLines[sourceLines.length - 1].length
            )
              throw Error("Incomplete layout");
            stage = "idle";
            needsLayout = false;
            resident = { source, revision };
            if (!disposed) changed({ status: "ready", revision, rows });
          } else {
            if (value.next <= page) throw Error("Layout made no progress");
            page = value.next;
            stage = "layout";
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error.message : "Malformed layout");
      }
    });
  });
  function chooseUpload(): "replace" | "edit" | "open" {
    const options = { key, revision, slot, width };
    if (resident) {
      const edit = editRange(resident.source, source);
      inline = { ...options, baseRevision: resident.revision, ...edit };
      if (edit.text.length <= TEXT_LAYOUT.inlineUnits && fitsRecord(inline))
        return "edit";
    }
    inline = { ...options, text: source };
    if (source.length <= TEXT_LAYOUT.inlineUnits && fitsRecord(inline))
      return "replace";
    inline = undefined;
    return "open";
  }
  return {
    update(text: string, options: { slot: number; width: number | null }) {
      if (disposed) throw Error("Text layout disposed");
      // A canceled mutation may already have executed. Never diff against an
      // unacknowledged provider revision; a fresh upload restores agreement.
      if (stage !== "idle") resident = undefined;
      if (request) client?.cancel(request);
      request = 0;
      revision++;
      needsLayout = true;
      source = text;
      slot = options.slot;
      width = options.width;
      rows = [];
      offset = 0;
      page = 0;
      if (text.length > TEXT_LAYOUT.maxDocument) {
        needsLayout = false;
        fail("Document exceeds experimental 64K UTF-16 limit");
        return revision;
      }
      sourceLines = text.split("\n");
      stage = chooseUpload();
      changed({
        status: textLayoutAvailable() ? "pending" : "companion-required",
        revision,
      });
      return revision;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (request) client?.cancel(request);
      request = 0;
      if (textLayoutAvailable()) {
        stage = "close";
      } else {
        stage = "idle";
        removePump();
      }
    },
  };
}
