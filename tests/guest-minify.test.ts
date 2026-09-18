import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Guest bundle minify contract: pass 2 of tools/build.ts uses Bun's whitespace
// mode. It removes comments/layout whitespace and may omit ASI-safe semicolons;
// identifiers are not renamed and syntax transforms are disabled. Fully
// minified esbuild output overflowed an ESP32-P4 QuickJS task's 8 KB parse
// stack, and another variant hit its watchdog after four minutes of parsing
// (site/content/blog/pocket-pi-on-esp32-p4.md), so this test fails if the build
// flips identifier/syntax minification on or whitespace minification off.

const repository = join(import.meta.dir, "..");
const fixture = join(repository, "tests/fixtures/whitespace-minify/main.tsx");
let outdir: string;
let bundle: string;

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "pocketjs-guest-minify-"));
  const p = Bun.spawnSync({
    cmd: [
      process.execPath,
      "tools/build.ts",
      fixture,
      "--no-config",
      `--outdir=${outdir}`,
    ],
    cwd: repository,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) {
    throw new Error(
      `fixture build failed (exit ${p.exitCode}):\n${p.stderr.toString()}`,
    );
  }
  const out = join(outdir, "main.js");
  expect(existsSync(out)).toBe(true);
  bundle = readFileSync(out, "utf8");
}, 120_000);

afterAll(() => {
  if (outdir) rmSync(outdir, { recursive: true, force: true });
});

describe("pass-2 guest bundle minify", () => {
  test("tools/build.ts config is whitespace-only", () => {
    const buildSource = readFileSync(
      join(repository, "tools/build.ts"),
      "utf8",
    );
    expect(buildSource).toContain(
      "minify: { whitespace: true, identifiers: false, syntax: false }",
    );
    // Guard against the literal `minify: false,` / `minify: true,` lines
    // coming back at the Bun.build call site (comments may mention them).
    const buildCall = buildSource.slice(
      buildSource.indexOf("const result = await Bun.build({"),
    );
    expect(buildCall).not.toMatch(/\n\s*minify: (false|true),/);
  });

  test("removes layout whitespace between tokens", () => {
    // Unminified output keeps ` = 7;\n  if (flag)` style spacing; compressed
    // output joins the canary function onto a single token-dense line.
    expect(bundle).toContain(
      "function canaryComputeCanary598(flag){const canaryLocalValue598=7;if(flag){return canaryLocalValue598}return canaryLocalValue598*2}",
    );
  });

  test("removes comments and may omit ASI-safe semicolons", () => {
    expect(bundle).not.toContain("Function source sentinel 630");
    expect(bundle).toContain(
      "function canaryFunctionSource630(){return 42}",
    );
    expect(bundle).not.toContain(
      "function canaryFunctionSource630(){return 42;}",
    );
  });

  test("does not rename identifiers (minify.identifiers stays off)", () => {
    expect(bundle).toContain("function canaryComputeCanary598(");
    expect(bundle).toContain("canaryLocalValue598");
    expect(bundle).toContain("function CanaryComponent598(");
  });

  test("does not rewrite syntax (minify.syntax stays off)", () => {
    // Full minification constant-folds `value ? true : false` into
    // `…?!0:!1`; whitespace-only output keeps the ternary tokens verbatim,
    // merely tight. Unminified output keeps the spaces (`? true : false`).
    expect(bundle).toContain("value?true:false");
    expect(bundle).not.toContain("?!0:!1");
  });

  test("preserves whitespace inside string and template literals", () => {
    // Tailwind class strings and JSX text are data, not layout.
    expect(bundle).toContain('"flex items-center"');
    expect(bundle).toContain("`canary `");
  });

  test("documents Function.prototype.toString observability", () => {
    const source = bundle.match(
      /function canaryFunctionSource630\(\)\{return 42\}/,
    )?.[0];
    expect(source).toBe("function canaryFunctionSource630(){return 42}");
    expect(source).not.toBe(
      "function canaryFunctionSource630() { return 42; }",
    );
  });
});
