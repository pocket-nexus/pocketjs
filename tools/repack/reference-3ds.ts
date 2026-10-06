// bun tools/repack/reference-3ds.ts --pocket <file> --id <id> --title <title>
//   --author <author> --version <version> [--icon <png>] [--fixtures <dir>]
//
// Checks tools/repack/3ds.ts against devkitPro's own tools: builds the same
// game's .3dsx with smdhtool and 3dsxtool in the pinned devkitARM image, from
// the runtime's ELF (dist/3ds/build/runtime/pocketjs-3ds.elf, written by
// `bun tools/runtime.ts 3ds`), the same scaled icons and a RomFS directory
// holding the same app.pocket, and byte-compares the SMDH, the RomFS and the
// whole file. Needs Docker; CI runs the committed fixtures instead
// (tests/repack-3ds.test.ts). --fixtures writes those fixtures.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { runContainer, type Mount } from "../3ds-toolchain.ts";
import { readRuntimeDirectory } from "../repack.ts";
import { encodePng } from "./shared/png.ts";
import { parse3dsx, repack3ds, smdhIcons } from "./3ds.ts";

const repository = resolvePath(new URL("../..", import.meta.url).pathname);

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function firstDifference(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return index;
  return left.length === right.length ? -1 : length;
}

export async function reference3ds(argv: readonly string[]): Promise<boolean> {
  const pocketPath = option(argv, "pocket");
  const identity = {
    id: option(argv, "id") ?? "",
    title: option(argv, "title") ?? "",
    author: option(argv, "author") ?? "",
    version: option(argv, "version") ?? "",
  };
  const iconPath = option(argv, "icon");
  const fixtures = option(argv, "fixtures");
  if (!pocketPath || !iconPath || Object.values(identity).some((value) => !value)) {
    throw new Error("usage: bun tools/repack/reference-3ds.ts --pocket <file> --id … --title … --author … --version … --icon <png> [--fixtures <dir>]");
  }
  const runtimeDirectory = join(repository, "dist/runtime/3ds");
  const elf = join(repository, "dist/3ds/build/runtime/pocketjs-3ds.elf");
  const pocket = new Uint8Array(readFileSync(pocketPath));
  const icon = new Uint8Array(readFileSync(iconPath));
  const ours = await repack3ds({ runtime: readRuntimeDirectory(runtimeDirectory), pocket, identity: { ...identity, icon } });

  const work = mkdtempSync(join(tmpdir(), "pocketjs-3ds-reference-"));
  try {
    mkdirSync(join(work, "romfs"));
    copyFileSync(pocketPath, join(work, "romfs/app.pocket"));
    copyFileSync(elf, join(work, "runtime.elf"));
    const { large, small } = await smdhIcons(icon);
    writeFileSync(join(work, "icon48.png"), await encodePng(large));
    writeFileSync(join(work, "icon24.png"), await encodePng(small));
    writeFileSync(
      join(work, "strings.env"),
      [`TITLE=${identity.title}`, `DESCRIPTION=${identity.title} ${identity.version}`, `AUTHOR=${identity.author}`].join("\n"),
    );
    const mounts: Mount[] = [{ hostPath: work, containerPath: "/work" }];
    await runContainer(
      [
        'TITLE="$(sed -n 1p strings.env | cut -d= -f2-)"',
        'DESCRIPTION="$(sed -n 2p strings.env | cut -d= -f2-)"',
        'AUTHOR="$(sed -n 3p strings.env | cut -d= -f2-)"',
        'smdhtool --create "$TITLE" "$DESCRIPTION" "$AUTHOR" icon48.png reference.smdh icon24.png',
        "3dsxtool runtime.elf reference.3dsx --romfs=romfs --smdh=reference.smdh",
      ].join("\n"),
      mounts,
      "/work",
      {},
      "smdhtool + 3dsxtool reference",
    );
    const reference = new Uint8Array(readFileSync(join(work, "reference.3dsx")));
    const referenceSmdh = new Uint8Array(readFileSync(join(work, "reference.smdh")));
    const parsedOurs = parse3dsx(ours);
    const parsedReference = parse3dsx(reference);
    const checks: Array<[string, Uint8Array, Uint8Array]> = [
      ["SMDH", parsedOurs.smdh!, referenceSmdh],
      ["RomFS", parsedOurs.romfs!, parsedReference.romfs!],
      [".3dsx", ours, reference],
    ];
    let same = true;
    for (const [label, left, right] of checks) {
      const at = firstDifference(left, right);
      console.log(`${label}: ${at < 0 ? "identical" : `differs at byte ${at}`} (${left.length} / ${right.length} bytes)`);
      same &&= at < 0;
    }
    if (fixtures) {
      mkdirSync(fixtures, { recursive: true });
      copyFileSync(join(work, "icon48.png"), join(fixtures, "icon48.png"));
      copyFileSync(join(work, "icon24.png"), join(fixtures, "icon24.png"));
      writeFileSync(join(fixtures, "smdhtool.smdh"), referenceSmdh);
      console.log(`fixtures: ${fixtures}`);
    }
    return same;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    process.exit((await reference3ds(Bun.argv.slice(2))) ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
