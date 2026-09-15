/** Public Vue SFC -> committed Rust source build entry. */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { analyzeVueAot } from "./aot-frontend.ts";
import { emitVueAot } from "./aot-codegen.ts";
import type { AotProgram } from "./aot-ir.ts";
import { requireVueAotBoard, vueAotBoardAdmission } from "./aot-admission.ts";

export interface VueAotBuildOptions {
  strict?: boolean;
  outDir?: string;
  format?: boolean;
  ir?: string;
  board?: string;
}
export interface VueAotBuildResult {
  entry: string;
  outDir: string;
  files: string[];
  program: AotProgram;
}

export function resolveVueAotEntry(app: string): string {
  const root = resolve(import.meta.dir, "../..");
  const candidates = [resolve(app), resolve(root, "apps", app)];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    if (statSync(path).isFile() && path.endsWith(".vue")) return path;
    if (!statSync(path).isDirectory()) continue;
    for (const name of ["app.vue", "App.vue", `${basename(path)}.vue`]) {
      const entry = join(path, name);
      if (existsSync(entry)) return entry;
    }
    const manifest = join(path, "pocket.json");
    if (existsSync(manifest)) {
      const entry = JSON.parse(readFileSync(manifest, "utf8")).app?.entry;
      if (typeof entry === "string" && entry.endsWith(".vue")) {
        const filename = resolve(path, entry);
        if (existsSync(filename)) return filename;
      }
    }
  }
  throw new Error(`Vue AOT: cannot resolve ${JSON.stringify(app)} to a root .vue component`);
}

export async function buildVueAot(app: string, options: VueAotBuildOptions = {}): Promise<VueAotBuildResult> {
  const entry = resolveVueAotEntry(app);
  const program = analyzeVueAot(entry, { strict: options.strict });
  if (options.board) requireVueAotBoard(program, options.board);
  const output = emitVueAot(program);
  const outDir = resolve(options.outDir ?? join(dirname(entry), "gen"));
  const files: string[] = [];
  const formatted = new Map<string, string>();
  // Format in memory before replacing generated files, so a broken emitter
  // never leaves the app with a mixture of old and new Rust modules.
  const rustfmt = options.format !== false ? Bun.which("rustfmt") : null;
  for (const [name, code] of Object.entries(output.files)) {
    if (isAbsolute(name) || relative(outDir, resolve(outDir, name)).startsWith("..")) {
      throw new Error(`Vue AOT: emitter returned invalid output path ${name}`);
    }
    let source = code;
    if (rustfmt && name.endsWith(".rs")) {
      const result = Bun.spawn([rustfmt, "--edition", "2021", "--emit", "stdout", "--config", "skip_children=true"], {
        stdin: new Blob([source]), stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, status] = await Promise.all([
        new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited,
      ]);
      if (status !== 0) throw new Error(`Vue AOT: rustfmt rejected ${name}:\n${stderr}`);
      source = stdout;
    }
    formatted.set(name, source);
  }
  mkdirSync(outDir, { recursive: true });
  for (const [name, code] of formatted) {
    const path = join(outDir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, code);
    files.push(path);
  }
  const stylePath = join(outDir, "styles.bin");
  writeFileSync(stylePath, Uint8Array.from(program.styles.bytes));
  files.push(stylePath);
  if (options.ir) {
    const path = resolve(options.ir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(program, null, 2) + "\n");
    files.push(path);
  }
  return { entry, outDir, files, program };
}

export async function runVueAotCli(args: string[]): Promise<void> {
  const command = args[0] === "check" ? "check" : "build";
  if (args[0] === "build" || args[0] === "check") args = args.slice(1);
  let app: string | undefined;
  let outDir: string | undefined;
  let ir: string | undefined;
  let strict = false;
  let json = false;
  let format = true;
  let board: string | undefined;
  let boards = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--strict") strict = true;
    else if (arg === "--json") json = true;
    else if (arg === "--no-format") format = false;
    else if (arg === "--boards") boards = true;
    else if (arg === "--out" || arg === "--ir" || arg === "--board") {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Vue AOT: ${arg} needs a path`);
      if (arg === "--out") outDir = value;
      else if (arg === "--ir") ir = value;
      else board = value;
    } else if (arg.startsWith("--out=")) outDir = arg.slice(6);
    else if (arg.startsWith("--ir=")) ir = arg.slice(5);
    else if (arg.startsWith("--board=")) board = arg.slice(8);
    else if (arg.startsWith("-")) throw new Error(`Vue AOT: unknown option ${arg}`);
    else if (app) throw new Error(`Vue AOT: unexpected argument ${arg}`);
    else app = arg;
  }
  if (!app) throw new Error("usage: bun vapor/compiler/cli.ts build <app|Root.vue> [--out gen] [--strict] [--ir file] [--board name] [--boards] [--no-format]");
  const result = command === "build"
    ? await buildVueAot(app, { strict, outDir, ir, format, board })
    : { entry: resolveVueAotEntry(app), program: analyzeVueAot(resolveVueAotEntry(app), { strict }), files: [] };
  const admission = vueAotBoardAdmission(result.program, board, boards);
  if (json) console.log(JSON.stringify(admission.length ? { ...result.program, admission } : result.program, null, 2));
  else {
    for (const diagnostic of result.program.diagnostics) {
      console.warn(`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.severity}: ${diagnostic.message}`);
    }
    console.log(`Vue AOT: ${result.program.root}, ${result.program.components.length} components, ${result.program.styles.records.length} styles`);
    for (const file of result.files) console.log(file);
    for (const row of admission) {
      console.log(`${row.board}: ${row.ok ? "OK" : "FAIL"} (input profile)`);
      for (const issue of row.issues) console.log(`  ${issue.severity} ${issue.code}: ${issue.message}`);
    }
  }
  if (board && admission.some(row => !row.ok)) process.exitCode = 1;
}
