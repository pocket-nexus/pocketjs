// tests/e2e/ppsspp.ts — deterministic PPSSPPHeadless E2E for the PSP host.
//
// Ported from origin/main:framework/test/fps3d-ppsspp.ts (driver shape) +
// origin/main:runtime/src/main.rs (capture feature, now in hosts/psp/src/main.rs):
// build the capture EBOOT with a baked input script, run PPSSPPHeadless with
// the software renderer (the only deterministic backend), decode the raw
// framebuffer dumps at the named shot frames, and byte-compare against
// committed goldens.
//
// Determinism contract: the core ticks a fixed dt (spec FIXED_DT = 1/60) and
// the input script is indexed by the RUST frame counter (hosts/psp/src/main.rs
// frame_count — the same counter that names the dumped files), so every frame
// is a pure function of its index and PPSSPP's software renderer is
// byte-stable run to run. Goldens are therefore compared byte-exact; they are
// only expected to drift when the emulator itself changes, which is why
// goldens/psp/PPSSPP-COMMIT.txt records the PPSSPP build the goldens came from.
//
//   bun run e2e            # compare against tests/goldens/psp/
//   UPDATE=1 bun run e2e   # regenerate goldens (then eyeball the PNGs!)
//
// Frameworks: pass --framework=vue-vapor|octane to run the demos through a
// non-default framework. Goldens then live in tests/goldens/psp-<framework>/
// and the spec table is filtered to demos that have that sibling variant
// (apps/<app>/app.<framework>.tsx).
//
// Host deps: ~/ppsspp-src/build/PPSSPPHeadless (source-built; see
// framework/test/bsp-compare/ppsspp-capture.md on origin/main) and ImageMagick.

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { FRAMEWORKS, parseFramework } from "../../framework/compiler/jsx-plugin.ts";

const frameworkArg = Bun.argv.find((a) => a.startsWith("--framework="));
const framework = parseFramework(frameworkArg?.slice("--framework=".length), "--framework");

const pspUiDir = new URL("../..", import.meta.url).pathname; // PocketJS/
const goldensDir =
  framework === "solid" ? `${pspUiDir}tests/goldens/psp` : `${pspUiDir}tests/goldens/psp-${framework}`;
const outDir = `${pspUiDir}dist/e2e-ppsspp`;
const headless = process.env.PPSSPP_HEADLESS || `${homedir()}/ppsspp-src/build/PPSSPPHeadless`;
// PPSSPPHeadless maps ms0: to ~/.ppsspp — dumps land in ~/.ppsspp/dc_cap.
// CAUTION: contents persist across runs; always clean before each run.
const dccap = `${homedir()}/.ppsspp/dc_cap`;
const eboot = `${pspUiDir}hosts/psp/target/mipsel-sony-psp/debug/EBOOT.PBP`;
const update = process.env.UPDATE === "1";

// ---------------------------------------------------------------------------
// Spec table. One entry per demo; one headless run per entry.
//
//   app          tools/psp.ts app name (hero -> apps/hero/main.tsx)
//   inputScript  "frame:mask,frame:mask" (contracts/spec/spec.ts BTN values), indexed by
//                the RUST frame counter; the active mask is the last threshold
//                at or before the current frame, so press = set, release = 0.
//                Edge-detection (framework/src/input.ts) needs a release between presses.
//   capStart/N   capture window (frames capStart..capStart+capN dumped),
//                baked into the EBOOT via POCKETJS_CAP_START/POCKETJS_CAP_N.
//   shots        frames to golden, each within [capStart, capStart+capN).
//
// Frame arithmetic: frame 0 is the first frame() call (after the slow QuickJS
// eval); the UI mounted during eval, so mount transitions/tweens start ticking
// at frame 0 (150 ms ≈ 9 frames, mount tween delays/durations add up from
// there). Frame content is a pure function of the frame index (fixed dt), so
// even mid-animation shots are byte-stable — settle margins below are for
// showing the *intended* state, not for determinism.
// ---------------------------------------------------------------------------
interface Spec {
  app: string;
  inputScript: string;
  capStart: number;
  capN: number;
  shots: { name: string; frame: number }[];
}

const SPECS: Spec[] = [
  {
    // hero: underline sweep = 150 ms delay + 700 ms tween ≈ settled by frame
    // 52; SVG-baked spinner cycles beside the headline. DOWN@58 focuses the
    // CTA, CIRCLE@76 increments Count and nudges the underline.
    app: "hero",
    inputScript: "0:0,58:0x40,62:0,76:0x2000,80:0",
    capStart: 48,
    capN: 48, // window 48..95
    shots: [
      { name: "boot", frame: 54 }, // settled first paint, sweep done, unfocused
      { name: "focused", frame: 72 }, // CTA focused (indigo-300), settled
      { name: "pressed", frame: 90 }, // after CIRCLE: "Count: 1", underline nudged
    ],
  },
  {
    // cards: nothing focused at boot; RIGHT@20 focuses card 1 (enter-from-end),
    // RIGHT@28 moves to card 2 "Motion" (lift + border transition, 150 ms),
    // CIRCLE@44 opens its detail panel (translateY spring, no color fade).
    // Ambient gradient streaks drift for 20+ s —
    // never "settled", but deterministic per frame index.
    app: "cards",
    inputScript: "0:0,20:0x20,24:0,28:0x20,32:0,44:0x2000,48:0",
    capStart: 16,
    capN: 80, // window 16..95
    shots: [
      { name: "layout", frame: 18 }, // three cards, header, no focus
      { name: "focused", frame: 40 }, // 2nd card lifted + emerald border
      { name: "opening", frame: 52 }, // detail just opened: white panel, no gray fade
      { name: "detail", frame: 88 }, // detail panel sprung into place
    ],
  },
  {
    // stats: counters count up over 75 frames from mount (capped signal),
    // bars stagger-grow from the capped frame signal. RIGHT@84 switches to
    // the SYSTEMS tab (short row reveal, no default gray flash).
    app: "stats",
    inputScript: "0:0,84:0x20,88:0",
    capStart: 28,
    capN: 100, // window 28..127
    shots: [
      { name: "midcount", frame: 30 }, // counters mid-count-up, bars part-grown
      { name: "overview", frame: 80 }, // OVERVIEW settled (count-up + bars done)
      { name: "systems", frame: 124 }, // SYSTEMS tab settled after RIGHT
    ],
  },
  {
    // library: RIGHT@8/16 walks focus to tile 1, CIRCLE@32 opens it — the
    // SVG-baked loading spinner auto-advances to the detail
    // screen after LOADING_FRAMES=48 (at frame 80), which then springs into
    // place (~30-40 frames to settle).
    app: "library",
    inputScript: "0:0,8:0x20,12:0,16:0x20,20:0,32:0x2000,36:0",
    capStart: 4,
    capN: 120, // window 4..123
    shots: [
      { name: "grid", frame: 6 }, // icon row settled, nothing focused
      { name: "focused", frame: 28 }, // tile 1 (IRON VANGUARD) focused: lift + scale-110
      { name: "loading", frame: 44 }, // SVG-baked spinner, not a rotating rectangle
      { name: "detail", frame: 112 }, // detail panel settled after the loading screen
    ],
  },
  {
    // settings: DOWN@4+CIRCLE@10 toggles SFX off, DOWN@16+CIRCLE@22 toggles
    // VIBRATION on, DOWN@28+CIRCLE@34 cycles brightness 3->4, three DOWNs
    // (40/44/48) walk the theme swatches to AMBER, CIRCLE@54 selects it
    // (header title recolors indigo -> amber).
    app: "settings",
    inputScript:
      "0:0,4:0x40,8:0,10:0x2000,14:0,16:0x40,20:0,22:0x2000,26:0,28:0x40,32:0,34:0x2000,38:0,40:0x40,42:0,44:0x40,46:0,48:0x40,52:0,54:0x2000,58:0",
    capStart: 0,
    capN: 100, // window 0..99
    shots: [
      { name: "boot", frame: 2 }, // SFX on, VIBRATION off, brightness 3/5, THEME indigo
      { name: "toggled", frame: 30 }, // SFX off, VIBRATION on (both knobs settled)
      { name: "themed", frame: 92 }, // brightness 4/5, THEME amber (title recolored)
    ],
  },
  {
    // notifications: DOWN@10/16 focuses item 1 (FRIEND REQUEST), CIRCLE@24
    // dismisses it — an imperative 200ms fade+slide fired from onPress, then
    // the local frame hook splices it out of the <For> list at frame 40
    // (focus repairs to the next sibling, BATTERY).
    app: "notifications",
    inputScript: "0:0,10:0x40,14:0,16:0x40,20:0,24:0x2000,28:0",
    capStart: 0,
    capN: 65, // window 0..64
    shots: [
      { name: "boot", frame: 2 }, // stagger-in: only item 0 visible yet
      { name: "dismissing", frame: 34 }, // item 1 mid-fade, still occupying its row
      { name: "settled", frame: 60 }, // 3 items reflowed, "3 UNREAD"
    ],
  },
  {
    // music: playing from mount (equalizer bars + progress advance every
    // frame, no tween). DOWN@4+CIRCLE@10 pauses (bars flatline). DOWN@30/36
    // walks to track row 1, CIRCLE@42 selects it (selectTrack() resumes
    // playback). RTRIGGER@70 skips to track 2.
    app: "music",
    inputScript: "0:0,4:0x40,8:0,10:0x2000,14:0,30:0x40,34:0,36:0x40,40:0,42:0x2000,46:0,70:0x0200,74:0",
    capStart: 0,
    capN: 95, // window 0..94
    shots: [
      { name: "playing", frame: 2 }, // track 0, bars bouncing, progress near 0%
      { name: "paused", frame: 20 }, // bars flatlined, progress frozen
      { name: "skipped", frame: 90 }, // track 2 (STATIC BLOOM) after the RTRIGGER skip
    ],
  },
  {
    // chrome: bevel border rings + the native active: press (spec op 26).
    // DOWN@8 focuses OK, RIGHT@16 moves to CANCEL; CIRCLE held 28..43 shows
    // the pressed bevel inversion, release restores the raised face.
    app: "chrome",
    inputScript: "0:0,8:0x40,12:0,16:0x20,20:0,28:0x2000,44:0",
    capStart: 0,
    capN: 60, // window 0..59
    shots: [
      { name: "focused", frame: 24 }, // CANCEL focused: face tint, raised bevel
      { name: "pressed", frame: 36 }, // CIRCLE held: bevel rings inverted
      { name: "released", frame: 52 }, // raised again after release
    ],
  },
  {
    // cursor: the virtual pointer (input.cursor, spec ops 27..29) on the
    // native host. d-pad steers at 1 px/frame (enableCursor dpadSpeed: 60):
    // UP 4..13 hovers row 2 (hover = focus: tint under the arrow), CIRCLE
    // 18..25 shows the active: inversion, release clicks (status line
    // updates), DOWN 30..61 rides to row 3, CIRCLE 66..73 clicks it.
    app: "cursor",
    inputScript: "0:0,4:0x10,14:0,18:0x2000,26:0,30:0x40,62:0,66:0x2000,74:0",
    capStart: 0,
    capN: 90, // window 0..89
    shots: [
      { name: "boot", frame: 2 }, // arrow at screen center, nothing hovered
      { name: "hover", frame: 16 }, // row 2 tinted under the pointer
      { name: "pressed", frame: 22 }, // active: bevel inversion while held
      { name: "clicked", frame: 64 }, // status shows row 2; pointer on row 3
      { name: "clicked-2", frame: 80 }, // status shows row 3
    ],
  },
  // ADD NEW DEMOS HERE: one Spec per demo, same shape.
];

// ---------------------------------------------------------------------------

if (!existsSync(headless)) {
  console.error(`PPSSPPHeadless not found at ${headless} (set PPSSPP_HEADLESS)`);
  process.exit(2);
}
if (!Bun.which("magick")) {
  console.error("ImageMagick `magick` not found (brew install imagemagick)");
  process.exit(2);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(goldensDir, { recursive: true });

function writeDemoManifest(app: string): string {
  const manifest = JSON.parse(readFileSync(`${pspUiDir}pocket.json`, "utf8")) as Record<string, any>;
  manifest.id = `dev.pocket-nexus.e2e.psp.${app.replace(/-/g, ".")}`;
  manifest.name = `pocketjs-e2e-${app}`;
  manifest.title = `PocketJS E2E ${app}`;
  manifest.app.entry = `apps/${app}/main.tsx`;
  manifest.app.output = `${app}-main`;
  manifest.app.framework = framework;
  const directory = `${outDir}/manifests`;
  const path = `${directory}/${app}.json`;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return path;
}

// Emulator provenance: byte-exact goldens are only promised for the PPSSPP
// build they were generated with.
const ppssppCommit = (await $`git -C ${homedir()}/ppsspp-src rev-parse HEAD`.text()).trim();
const commitStamp = `${goldensDir}/PPSSPP-COMMIT.txt`;
const stampedCommit = existsSync(commitStamp) ? readFileSync(commitStamp, "utf8").trim() : null;

// Non-default frameworks cover exactly the demos that carry the sibling
// variant; the rest stay Solid-only.
const selectedSpecs =
  framework === "solid"
    ? SPECS
    : SPECS.filter((spec) =>
        existsSync(`${pspUiDir}apps/${spec.app}/app${FRAMEWORKS[framework].outputSuffix}.tsx`),
      );
if (selectedSpecs.length === 0) {
  console.error(`no demos carry an app${FRAMEWORKS[framework].outputSuffix}.tsx variant`);
  process.exit(2);
}
console.log(`framework: ${framework} (${selectedSpecs.length} demo(s), goldens: ${goldensDir})`);

let failed = false;

for (const spec of selectedSpecs) {
  console.log(`\n## ${spec.app} (input: ${spec.inputScript})`);
  const manifest = writeDemoManifest(spec.app);

  // 1. Build through the manifest/plan path so E2E also exercises the
  // target/HostOps ABI startup handshake.
  console.log("# build capture EBOOT ...");
  await $`bun tools/pocket.ts build --target psp --manifest ${manifest} --project-root ${pspUiDir} -- --capture`
    .cwd(pspUiDir)
    .env({
      ...process.env,
      POCKETJS_CAPTURE_INPUT: spec.inputScript,
      POCKETJS_CAP_START: String(spec.capStart),
      POCKETJS_CAP_N: String(spec.capN),
    })
    .quiet();

  // 2. One headless run; frames land in ms0:/dc_cap (stale files persist
  //    across runs — clean first). Generous timeout: QuickJS evaluating the
  //    bundle takes ~8-10 emulated seconds before frame 0.
  //    PPSSPP maps the EBOOT's own directory as host0:, so a DevTools
  //    mailbox left in the target dir by a hardware session (bun devtools)
  //    would activate mid-golden and could feed the app stale commands —
  //    remove it for determinism.
  console.log("# PPSSPPHeadless (software renderer) ...");
  rmSync(dccap, { recursive: true, force: true });
  rmSync(`${pspUiDir}hosts/psp/target/mipsel-sony-psp/debug/pocketjs-dbg`, {
    recursive: true,
    force: true,
  });
  const timeout = Number(process.env.E2E_PPSSPP_TIMEOUT || 45);
  const run =
    await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`.cwd("/tmp").nothrow().quiet();

  // 3. FPS-floor / liveness check (non-golden). This asserts ONLY that the
  //    frame loop presented all CAP_N frames within the timeout — i.e. boot
  //    completed and the loop is not wedged or catastrophically slow. It does
  //    NOT measure real frame rate: PPSSPPHeadless runs unthrottled and host
  //    load makes wall-clock FPS ~2x noisy (the hero "fps 60" stat is a
  //    hardcoded string, not a measurement).
  const produced = existsSync(dccap) ? readdirSync(dccap).filter((f) => /^f\d{4}\.raw$/.test(f)).length : 0;
  if (produced !== spec.capN) {
    console.error(
      `FAIL ${spec.app}: produced ${produced}/${spec.capN} capture frames within ${timeout}s ` +
        `(boot hang or wedged frame loop). PPSSPP stdout:\n${run.stdout}${run.stderr}`,
    );
    failed = true;
    continue;
  }
  console.log(
    `liveness: ${produced}/${spec.capN} frames dumped (loop alive through frame ${spec.capStart + spec.capN - 1})`,
  );

  // 4. Decode + compare each shot.
  for (const shot of spec.shots) {
    if (shot.frame < spec.capStart || shot.frame >= spec.capStart + spec.capN) {
      throw new Error(`${spec.app}.${shot.name}: frame ${shot.frame} outside capture window`);
    }
    const idx = String(shot.frame - spec.capStart).padStart(4, "0");
    const raw = `${dccap}/f${idx}.raw`;

    // Refuse degenerate captures (all-black boot frame etc.) even in UPDATE
    // mode: a golden must show actual UI. "Non-flat" = >= 3 distinct pixel
    // values inside the visible 480x272 region (the raw is 512-stride).
    const buf = readFileSync(raw);
    const pixels = new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const distinct = new Set<number>();
    outer: for (let y = 0; y < 272; y++) {
      for (let x = 0; x < 480; x++) {
        distinct.add(pixels[y * 512 + x]);
        if (distinct.size >= 3) break outer;
      }
    }
    if (distinct.size < 3) {
      console.error(`FAIL ${spec.app}.${shot.name}: frame ${shot.frame} is flat (${distinct.size} distinct pixels)`);
      failed = true;
      continue;
    }

    // dc_cap raws are 512-stride RGBA top-down; crop to the 480x272 screen.
    // exclude-chunks=date,time: magick otherwise embeds creation timestamps
    // in tEXt chunks, which breaks byte-exact golden comparison.
    const png = `${outDir}/${spec.app}.${shot.name}.png`;
    await $`magick -size 512x272 -depth 8 RGBA:${raw} -alpha off -crop 480x272+0+0 +repage -depth 8 -define png:exclude-chunks=date,time PNG24:${png}`.quiet();

    const golden = `${goldensDir}/${spec.app}.${shot.name}.png`;
    if (update) {
      writeFileSync(golden, readFileSync(png));
      console.log(`updated ${spec.app}.${shot.name}.png (frame ${shot.frame})`);
      continue;
    }
    if (!existsSync(golden)) {
      console.error(`FAIL ${spec.app}.${shot.name}: golden missing — run UPDATE=1 bun run e2e`);
      failed = true;
      continue;
    }
    const a = readFileSync(png);
    const b = readFileSync(golden);
    if (a.equals(b)) {
      console.log(`ok ${spec.app}.${shot.name} (frame ${shot.frame}, byte-exact)`);
    } else {
      writeFileSync(`${goldensDir}/${spec.app}.${shot.name}.actual.png`, a);
      console.error(
        `FAIL ${spec.app}.${shot.name}: differs from golden ` +
          `(actual -> ${goldensDir.slice(pspUiDir.length)}/${spec.app}.${shot.name}.actual.png)`,
      );
      if (stampedCommit && stampedCommit !== ppssppCommit) {
        console.error(
          `  note: PPSSPP build differs (goldens: ${stampedCommit.slice(0, 12)}, ` +
            `local: ${ppssppCommit.slice(0, 12)}) — emulator drift, not necessarily a ` +
            `PocketJS regression. Re-baseline with UPDATE=1, or fall back to threshold ` +
            `compare (origin/main framework/test/bsp-compare/diff.ts: IoU>=0.995, meanRGB<=8).`,
        );
      }
      failed = true;
    }
  }
}

if (update) {
  writeFileSync(commitStamp, `${ppssppCommit}\n`);
  console.log(`\ngoldens + PPSSPP-COMMIT.txt (${ppssppCommit.slice(0, 12)}) -> ${goldensDir}`);
} else if (stampedCommit && stampedCommit !== ppssppCommit && !failed) {
  console.log(`\nnote: local PPSSPP ${ppssppCommit.slice(0, 12)} != golden stamp ${stampedCommit.slice(0, 12)}, but bytes still match.`);
}

console.log(failed ? "\nE2E FAILED" : "\nE2E OK");
process.exit(failed ? 1 : 0);
