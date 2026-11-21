import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(new URL("..", import.meta.url).pathname);
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "pocketjs-build-writes-")));
  temporary.push(path);
  return path;
}

describe("where a build writes", () => {
  test("the style copy goes beside the bundle, the transform cache under the cache root, nothing into the framework", () => {
    const outdir = scratch();
    const cache = scratch();
    const committedStyles = readFileSync(join(root, "framework/src/styles.generated.ts"));
    const frameworkSources = readdirSync(join(root, "framework/src")).sort();
    // A checkout may hold a transform cache from before the cache root; the
    // build adds nothing to it.
    const legacyCache = join(root, ".cache/transforms");
    const legacyEntries = () => (existsSync(legacyCache) ? readdirSync(legacyCache).length : 0);
    const legacyBefore = legacyEntries();

    const result = Bun.spawnSync({
      cmd: [process.execPath, "tools/build.ts", "hero", `--outdir=${outdir}`],
      cwd: root,
      env: { ...process.env, POCKET_NEXUS_CACHE_DIR: cache },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);

    const copy = readFileSync(join(outdir, "hero.styles.ts"), "utf8");
    expect(copy).toContain("export const STYLE_IDS");
    expect(copy).toMatch(/"[^"]+": \d+,/);
    expect(result.stdout.toString()).toContain(`-> ${join(outdir, "hero.styles.ts")}`);

    expect(readdirSync(join(cache, "transforms")).length).toBeGreaterThan(0);

    expect(readFileSync(join(root, "framework/src/styles.generated.ts"))).toEqual(committedStyles);
    expect(readdirSync(join(root, "framework/src")).sort()).toEqual(frameworkSources);
    expect(legacyEntries()).toBe(legacyBefore);
  }, 120_000);

  test("the committed style module is the empty table", async () => {
    const styles = await import("../framework/src/styles.generated.ts");
    expect(styles.STYLE_IDS).toEqual({});
    expect(styles.STYLE_COUNT).toBe(0);
    expect(styles.FONT_SLOTS).toEqual({});
  });
});
