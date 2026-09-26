# Shared Solid Hero

**`app.tsx` is the public Hero entry for JavaScript guests and MicroTS.** It applies default props and mounts `Hero.tsx`. The shared view calls the `createHero` factory in `Hero.ts` for its count, spinner, node reference, and animation commands. Each mounted Hero owns one model region; unmount cancels its pending spinner wait.

The default layout uses 480×272. `largeLayout` retains the larger typography and spacing used by device guests. **`compact` selects a layout for 256×192**, with a frame-rate badge and direct button color changes. Header, description, and footer rows retain wrapping in the standard and large layouts.

Existing device props remain supported: `actionLabel`, `deviceLabel`, `headline`, `largeLayout`, `onAction`, `presentationHz`, `runtimeLabel`, and `spinnerFrameStep`. The `onAction` callback receives the updated count on each activation.

**The default spinner wait is 100 ms.** An explicit positive `spinnerFrameStep` converts to milliseconds using `presentationHz`; six steps at 60 Hz give a 100 ms wait. Eight static images switch opacity without changing their layout. The underline starts after 150 ms, grows over 700 ms, and offsets by the count modulo eight.

```sh
bun tools/build.ts apps/hero/main.tsx --framework=solid
bun microts/compiler/cli.ts check hero --strict
```

The manifest's `app.model = "compiled"` selects the same TypeScript model for generated JavaScript and generated Rust.
