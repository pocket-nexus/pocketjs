/** Codec / fetch failures and cancellation are isolated from the relay process. */
import { importBook } from "./import.ts";
import type { ImportRequest } from "./store.ts";
import type { Source } from "./sources.ts";
process.on("disconnect", () => process.exit(0));
process.once("message", async (data: { root: string; input: ImportRequest; source?: Source; allowPrivate: boolean; stage: string }) => {
  const { root, input, source, allowPrivate, stage } = data;
  try {
    const book = await importBook(root, input, source, { allowPrivate }, (message, done, total) => process.send?.({ message, done, total }), stage);
    process.send?.({ book });
  } catch (error) { process.send?.({ error: error instanceof Error ? error.message : "Import failed" }); }
});
