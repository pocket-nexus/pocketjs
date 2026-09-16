import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFontArchiveProvider } from "./font-archive-provider.ts";
import { dispatchOffload } from "./offload-provider.ts";
import type { OffloadMethods } from "./offload-capabilities.ts";
let methods: OffloadMethods = {};
self.onmessage = async ({ data }) => {
  if (data.init) {
    const root = data.init.directory as string;
    const fonts = createFontArchiveProvider({ "fonts/cjk.pjfa": join(root, "fonts/cjk.pjfa") });
    const files = new Set(["common.txt", "songs.txt", "chapter-1.txt", "chapter-2.txt"]);
    methods = { ...fonts.methods, "fs.read-text": path => {
      if (!files.has(path)) throw new Error("Document path not granted");
      const text = readFileSync(join(root, path), "utf8");
      if (Buffer.byteLength(text) > 1536) throw new Error("Document page exceeds budget");
      return text;
    } };
    self.postMessage({ ready: true }); return;
  }
  self.postMessage(await dispatchOffload(methods, data));
};
