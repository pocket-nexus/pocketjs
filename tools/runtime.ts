// bun tools/runtime.ts <target> [options] — build the generic runtime for a
// target into dist/runtime/<target>/ with runtime.json beside it. A runtime
// carries no game; tools/repack.ts pairs it with one.

const TARGETS: Record<string, () => Promise<(argv: readonly string[]) => Promise<string>>> = {
  "3ds": async () => (await import("./runtime/3ds.ts")).buildRuntime3ds,
  android: async () => (await import("./runtime/android.ts")).buildRuntimeAndroid,
  psp: async () => (await import("./runtime/psp.ts")).buildRuntimePsp,
  vita: async () => (await import("./runtime/vita.ts")).buildRuntimeVita,
};

if (import.meta.main) {
  const [target, ...rest] = Bun.argv.slice(2);
  const load = target ? TARGETS[target] : undefined;
  if (!load) {
    console.error(`usage: bun tools/runtime.ts <${Object.keys(TARGETS).join("|")}> [options]`);
    process.exit(1);
  }
  try {
    await (await load())(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
