import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connectOffloadProvider } from "../../tools/offload-provider.ts";
import { serveMangaRelay } from "./companion/relay.ts";
import { serveManga } from "./companion/server.ts";
import { MangaStore } from "./companion/store.ts";
import { packPath } from "./companion/packs.ts";
import { packOf } from "./model.ts";
import { encodeDocument } from "./document.ts";
import { createResourcePack } from "./pack-format.ts";

export function exportLibrary(root: string, out: string) {
  if (resolve(out) === resolve(root, "packs")) throw Error("Export to an SD directory, not the companion pack directory");
  const store = new MangaStore(root);
  try {
    const index = store.index();
    mkdirSync(out, { recursive: true });
    // Copy immutable content first. Publish the new index only after every
    // referenced series has been copied; an interrupted export keeps the old one.
    for (const book of index.series) {
      const name = `${packOf(book)}.prp`;
      copyFileSync(packPath(root, packOf(book)), join(out, name + ".partial"));
      renameSync(join(out, name + ".partial"), join(out, name));
    }
    const doc = encodeDocument(index, 1), pack = createResourcePack(join(out, "manga-index.prp"), 1 + doc.chunks.length);
    try { for (const part of [doc.head, ...doc.chunks]) pack.add(Buffer.from(part)); pack.finish(); }
    catch (error) { pack.abort(); throw error; }
    return index.series.length;
  } finally { store.close(); }
}

export async function main(args = process.argv.slice(2)) {
  try {
    let command = "serve", root = ".pocket/manga-relay", out = "", port = 8743, relayPort = 8742, relayHost = "127.0.0.1", device = "", devicePort = 8741, keyFile = "", allowPrivate = false;
    if (args[0] === "export" || args[0] === "serve") command = args.shift()!;
    for (let n = 0; n < args.length; n++) {
      const arg = args[n]!;
      const value = () => { const v = args[++n]; if (!v || v.startsWith("--")) throw Error(`${arg} needs a value`); return v; };
      if (arg === "--root") root = value(); else if (arg === "--out") out = value();
      else if (arg === "--port") port = Number(value()); else if (arg === "--device") device = value();
      else if (arg === "--relay-port") relayPort = Number(value()); else if (arg === "--relay-host") relayHost = value();
      else if (arg === "--device-port") devicePort = Number(value()); else if (arg === "--key-file") keyFile = value();
      else if (arg === "--allow-private-sources") allowPrivate = true;
      else if (arg === "--help" || arg === "-h") {
        console.log("Pocket Manga companion\n  bun apps/manga/companion.ts [serve] [--root DIR] [--port 8743] [--relay-port 8742] [--relay-host 127.0.0.1] [--device IP] [--key-file FILE] [--allow-private-sources]\n  bun apps/manga/companion.ts export --out SD_ASSET_DIRECTORY [--root DIR]"); process.exit(0);
      } else throw Error(`Unknown argument: ${arg}`);
    }
    root = resolve(root);
    if (command === "export") { if (!out) throw Error("--out is required"); console.log(`Exported ${exportLibrary(root, resolve(out))} series to ${resolve(out)}`); }
    else {
      if (![port, devicePort, relayPort].every(n => Number.isInteger(n) && n > 0 && n <= 65535)) throw Error("Invalid port");
      const companion = serveManga({ root, port, allowPrivate });

      let provider: ReturnType<typeof connectOffloadProvider> | undefined;
      keyFile = keyFile ? resolve(keyFile) : join(root, "pairing.key");
      if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
      const key = readFileSync(keyFile, "utf8").trim();
      let relay: Awaited<ReturnType<typeof serveMangaRelay>>;
      try { relay = await serveMangaRelay({ root, port: relayPort, host: relayHost, key, log: console.error }); }
      catch (error) { companion.close(); throw error; }
      console.log(`Pocket Manga companion: ${companion.server.url}\nRelay: ${relayHost}:${relay.port}\nLibrary: ${root}\nPairing key: ${keyFile}`);
      if (device) {
        const slot = createHash("sha256").update("dev.pocket-stack.manga").digest("hex").slice(0, 16);
        console.log(`Pairing: copy ${keyFile} to sdmc:/pocketjs/offload/${slot}.key`);
        provider = connectOffloadProvider({ address: device, port: devicePort, key, worker: new URL("./companion/provider-worker.ts", import.meta.url), data: { root }, isolation: "process", log: console.log });
      }
      const close = async () => { provider?.close(); companion.close(); await relay.close(); process.exit(0); };
      process.on("SIGINT", close); process.on("SIGTERM", close);
    }
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1); }
}

if (import.meta.main) await main();
