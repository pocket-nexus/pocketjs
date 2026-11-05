// tests/helpers/fake-rustup.ts — a rustup that keeps toolchains in a state
// directory and fakes `cargo install` by writing $FAKE_CARGO_BINARIES into
// --root/bin. Every invocation is appended to <state>/calls.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fakeRustup(directory: string, installed: Record<string, { components?: string[]; targets?: string[] }> = {}): { rustup: string; state: string } {
  const state = join(directory, "state");
  mkdirSync(state, { recursive: true });
  for (const [toolchain, { components = [], targets = [] }] of Object.entries(installed)) {
    mkdirSync(join(state, toolchain), { recursive: true });
    writeFileSync(join(state, toolchain, "components"), components.map((name) => `${name}\n`).join(""));
    writeFileSync(join(state, toolchain, "targets"), targets.map((name) => `${name}\n`).join(""));
  }
  const rustup = join(directory, "rustup");
  writeFileSync(rustup, `#!/bin/bash
set -e
STATE="${state}"
echo "$*" >> "$STATE/calls"
flag() { local name="$1"; shift; local out=(); while [ $# -gt 0 ]; do if [ "$1" = "$name" ]; then out+=("$2"); shift; fi; shift; done; echo "\${out[@]}"; }
case "$1 $2" in
  "toolchain list") for t in "$STATE"/*/; do [ -d "$t" ] && echo "$(basename "$t")-test-host"; done; exit 0 ;;
  "toolchain install") mkdir -p "$STATE/$3"; for c in $(flag --component "$@"); do echo "$c" >> "$STATE/$3/components"; done; for t in $(flag --target "$@"); do echo "$t" >> "$STATE/$3/targets"; done; touch "$STATE/$3/components" "$STATE/$3/targets"; exit 0 ;;
  "component list") tc=$(flag --toolchain "$@"); [ -d "$STATE/$tc" ] || exit 1; echo "cargo-test-host"; cat "$STATE/$tc/components"; exit 0 ;;
  "target list") tc=$(flag --toolchain "$@"); [ -d "$STATE/$tc" ] || exit 1; cat "$STATE/$tc/targets"; exit 0 ;;
  "component add") tc=$(flag --toolchain "$@"); shift 4; for c in "$@"; do echo "$c" >> "$STATE/$tc/components"; done; exit 0 ;;
  "target add") tc=$(flag --toolchain "$@"); shift 4; for t in "$@"; do echo "$t" >> "$STATE/$tc/targets"; done; exit 0 ;;
esac
if [ "$1" = "run" ] && [ "$3 $4" = "cargo install" ]; then
  [ -d "$STATE/$2" ] || { echo "toolchain $2 is not installed" >&2; exit 1; }
  root=$(flag --root "$@"); mkdir -p "$root/bin"
  for b in $FAKE_CARGO_BINARIES; do echo "#!/bin/sh" > "$root/bin/$b"; chmod +x "$root/bin/$b"; done
  exit 0
fi
echo "fake rustup: unexpected $*" >&2; exit 2
`);
  chmodSync(rustup, 0o755);
  return { rustup, state };
}
