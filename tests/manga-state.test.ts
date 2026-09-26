import { afterEach, expect, test } from "bun:test";
import { fsHost } from "@pocketjs/framework/fs";
import { loadProgress, saveProgress, stateAvailable, deviceIdentity } from "../apps/manga/state.ts";
import { emptyProgress, withPage, type Progress } from "../apps/manga/progress.ts";

const scope = globalThis as unknown as { fs?: unknown; state?: unknown };
const previous = { fs: scope.fs, state: scope.state };
afterEach(() => { scope.fs = previous.fs; scope.state = previous.state; });
function filesystem(failAt = Infinity) {
  const records = new Map<string, string>();
  let writes = 0;
  scope.state = undefined;
  scope.fs = {
    stat: (path: string) => JSON.stringify(records.has(path) ? { kind: "file", size: Buffer.byteLength(records.get(path)!) } : { error: "not found" }),
    read(path: string, offset: number, limit: number) {
      const all = Buffer.from(records.get(path)!);
      return JSON.stringify({ data: { $b: all.subarray(offset, offset + limit).toString("base64") }, size: all.length, eof: offset + limit >= all.length });
    },
    write(path: string, data: string, mode: number) {
      if (++writes === failAt) return 1;
      records.set(path, (mode ? records.get(path) ?? "" : "") + JSON.parse(data)); return 0;
    },
    rename(from: string, to: string) { records.set(to, records.get(from)!); records.delete(from); return 0; },
    lastError: () => "disk full",
  };
  return records;
}
test("progress uses the existing filesystem and keeps the reader identity across reload", () => {
  const records = filesystem();
  expect(fsHost()).not.toBeNull(); expect(stateAvailable()).toBe(true);
  const progress = withPage(emptyProgress(), "book", 12, 99);
  expect(saveProgress(progress)).toBe(true);
  expect(records.has("state.json.partial")).toBe(false);
  expect(loadProgress()).toEqual(progress);
  expect(JSON.parse(records.get("state.json")!).device).toBe(deviceIdentity());
});
test("a failed multipart filesystem save leaves the previous progress intact", () => {
  const records = filesystem(2);
  const previous = withPage(emptyProgress(), "book", 3, 1);
  records.set("state.json", JSON.stringify(previous));
  const next = withPage(previous, "book", 99, 2);
  next.series.book!.bookmarks = Array.from({ length: 6500 }, (_, n) => n);
  expect(saveProgress(next)).toBe(false);
  expect(loadProgress()).toEqual(previous);
});
test("3DS keeps its existing state file without requiring a new framework SDK", () => {
  scope.fs = undefined;
  let raw = JSON.stringify({ ...withPage(emptyProgress(), "book", 4, 8), device: "reader-existing" });
  scope.state = { read: () => raw, write: (text: string) => { raw = text; return 0; } };
  expect(stateAvailable()).toBe(true); expect(loadProgress().series.book!.page).toBe(4);
  expect(deviceIdentity()).toBe("reader-existing");
  expect(saveProgress(withPage(loadProgress(), "book", 5, 9))).toBe(true);
  expect(JSON.parse(raw).device).toBe("reader-existing");
  expect(loadProgress().series.book!.page).toBe(5);
});
test("missing, corrupt, failed and oversized storage cannot report a successful save", () => {
  scope.fs = undefined; scope.state = undefined;
  expect(stateAvailable()).toBe(false); expect(saveProgress(emptyProgress())).toBe(false);
  expect(loadProgress()).toEqual(emptyProgress());
  let writes = 0;
  scope.state = { read: () => "{broken", write: () => { writes++; return 1; } };
  expect(loadProgress()).toEqual(emptyProgress()); expect(saveProgress(emptyProgress())).toBe(false);
  const large = { ...emptyProgress(), extra: "漫".repeat(30000) } as Progress;
  expect(saveProgress(large)).toBe(false); expect(writes).toBe(1);
});
