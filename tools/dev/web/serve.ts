// tools/dev/web/serve.ts — tiny static dev server for the browser host.
//
//   bun tools/dev/web/serve.ts            # http://127.0.0.1:8130
//   PORT=9000 bun tools/dev/web/serve.ts
//
// Serves programs/web/dev/ at /, dist/ at /dist/, a /demos JSON manifest, the
// Pocket DevTools panel at /devtools and its WS hub at /ws — all implemented
// in tools/dev/web/server.ts (this file is the CLI wrapper; tools/devtools.ts
// embeds the same module for the one-command DX).
//
// Dev-tool only: binds 127.0.0.1, no cache, no livereload (reload the page
// after `bun tools/build.ts <demo>` / `bun tools/wasm.ts`).

import { demoManifest, startDevServer } from "./server.ts";

const server = startDevServer();

console.log(
  `PocketJS programs/web/dev: ${server.url}  (demos: ${demoManifest().map((d) => d.name).join(", ") || "none — build one first"})`,
);
console.log(`Pocket DevTools:   ${server.panelUrl}`);
