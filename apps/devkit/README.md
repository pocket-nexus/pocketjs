# Pocket Devkit

The PS Vita development container. Install its VPK once; afterwards every
PocketJS build under test reaches the console over the USB cable:

- `bun run vita:dev push --app devkit` replaces its JS/PAK guest;
- `bun run vita:dev native --app devkit --runtime <app>.runtime.json` runs
  another native build (built with title `P25BFE5E2`) from the inactive
  `pocket-dev-a.self` or `pocket-dev-b.self` slot.

Its installed `eboot.bin` is never replaced: reopening the LiveArea bubble
starts this screen again. The wired transport, menu and replacement rules are
in [docs/VITA-USB.md](../../docs/VITA-USB.md). LiveArea art lives in `vita/`
and overlays the framework defaults when `tools/vita.ts` packages the VPK.
