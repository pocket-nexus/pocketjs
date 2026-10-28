// bun tools/playset-mirror.ts <demo> <outdir>
//
// Mirror a GameBlocks demo's unbundled ES modules (https://gb-<demo>.vercel.app,
// MIT, xt4d/GameBlocks) by following its relative imports from index.html and
// src/main.js. The copy is source to port from; it is never built or run.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [name, out] = process.argv.slice(2);
const base = `https://gb-${name}.vercel.app/`;
const seen = new Set<string>();
const queue = ["index.html", "style.css", "src/main.js"];
while (queue.length) {
  const rel = queue.shift()!;
  if (seen.has(rel)) continue;
  seen.add(rel);
  const res = await fetch(base + rel);
  if (!res.ok) { console.error("miss", rel, res.status); continue; }
  const text = await res.text();
  const path = join(out, name, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (!rel.endsWith(".js")) continue;
  const re = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const m of text.matchAll(re)) {
    const spec = m[1] ?? m[2] ?? m[3];
    const url = new URL(spec, base + rel);
    queue.push(url.pathname.slice(1));
  }
}
console.log(name, seen.size, "files");
