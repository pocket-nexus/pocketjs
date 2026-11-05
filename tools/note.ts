// bun run note [flags…] — build + launch the markdown sticky note
// (engine/pocket3d/examples/note-widget over apps/note, the flat pocket-widget
// runtime; docs/WIDGET.md §2b).
//
//   bun run note                    # your note (~/.pocket-note.md)
//   bun run note -- --file todo.md  # any markdown file
//   bun run note -- --width 380 --height 520
//   bun run note --proof            # headless acceptance: click into the
//                                   # sample, type, autosave round-trips,
//                                   # screenshot lands in dist/
//
// The windowed run stays attached to your terminal — ⌘Q quits (or Ctrl-C
// here). On exit the shell prints its governor receipt:
// "pocket-widget: N ticks, M frames rendered" — a settled note should show
// M ≪ N (measured: 2 frames over 481 ticks).
import { mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { $ } from "bun";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";
import { readPocketManifest } from "../framework/src/manifest/load.ts";
import { exportProfile } from "./profile-export.ts";

const root = new URL("..", import.meta.url).pathname;
const args = process.argv.slice(2).filter((a) => a !== "--");
const proof = args.includes("--proof");
const pass = args.filter((f) => f !== "--proof");

// The note builds through its manifest against the macos-widget
// target profile — density, viewport and capability features all come from
// the platform contract, not flags.
const manifest = readPocketManifest(`${root}apps/note/pocket.app.json`).manifest;
const resolution = validateAndResolveBuildPlan(manifest, { target: "macos-widget" });
if (!resolution.ok) {
  throw new Error(
    `pocket-note: manifest did not resolve: ${resolution.diagnostics
      .map((d) => `${d.path || "/"}: ${d.message}`)
      .join("; ")}`,
  );
}
const planPath = `${root}.pocket/desktop-widget/note-main.plan.json`;
mkdirSync(resolvePath(planPath, ".."), { recursive: true });
await Bun.write(planPath, JSON.stringify(resolution.plan, null, 2) + "\n");

await $`bun tools/build.ts --plan=${planPath} --project-root=${root}`.cwd(root);
// The widget compiles in the profile the note was resolved against.
const { plan } = resolution;
const exported = exportProfile(
  { profile: plan.profile, profileHash: plan.profileHash, hostAbi: plan.target.hostAbi, dependencies: [] },
  `${root}.pocket/desktop-widget/profile`,
);
await $`cargo build --locked --release -p note-widget`
  .cwd(root)
  .env({ ...process.env, POCKETJS_PROFILE_RS: exported.module });

const bin = `${root}target/release/note-widget`;
const env = { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "info" };

if (proof) {
  const shot = `${root}dist/note-proof.png`;
  const file = `${root}dist/note-proof.md`;
  await $`rm -f ${file}`;
  await $`${bin} --file ${file} --screenshot ${shot} --frames 130 --click 350,15@10 --type PROOF-@30 ${pass}`.env(
    env,
  );
  const saved = (await Bun.file(file).text()).includes("PROOF-");
  if (!saved) throw new Error("note proof: autosave round-trip missed the typed text");
  console.log(
    "\nproof: the pencil toggle opened the editor, typing landed at the" +
      "\ncaret, and the debounced autosave wrote the file back out." +
      `\n${shot}`,
  );
  await $`open ${shot}`.nothrow();
} else {
  await $`${bin} ${pass}`.env(env);
}
