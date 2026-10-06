import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";
import ts from "typescript";
import type { PocketFramework } from "../src/config.ts";
import { POCKET_FRAMEWORKS, SUBPATHS } from "./subpaths.ts";

export interface AppCheckOptions {
  entry: string;
  /** Optional app tsconfig whose compiler options/path mappings are inherited. */
  tsconfigPath?: string;
  /** Framework/app ambient declarations required by the reachable source graph. */
  declarationFiles?: readonly string[];
  /** Keep the generated directory for debugging failed checks. */
  keepTemporaryFiles?: boolean;
}

export interface AppCheckDiagnostic {
  code: number;
  category: "warning" | "error" | "suggestion" | "message";
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface AppCheckArtifacts {
  tsconfig: string;
  /** Present only when keepTemporaryFiles is true. */
  directory?: string;
}

export interface AppCheckResult {
  ok: boolean;
  diagnostics: AppCheckDiagnostic[];
  /** Non-declaration files reached from entry. Unrelated project files stay out. */
  checkedFiles: string[];
  artifacts: AppCheckArtifacts;
}

function configJson(
  entry: string,
  tsconfigPath: string | undefined,
  declarationFiles: readonly string[],
): string {
  const config: Record<string, unknown> = {
    ...(tsconfigPath ? { extends: tsconfigPath } : {}),
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
      jsx: "preserve",
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      incremental: false,
      composite: false,
      ...(tsconfigPath ? {} : { types: [] }),
    },
    files: [entry, ...declarationFiles],
    // Never inherit a broad include/exclude set: files plus normal module
    // resolution is the exact entry/import graph contract.
    include: [],
    exclude: [],
  };
  return JSON.stringify(config, null, 2) + "\n";
}

function diagnosticCategory(category: ts.DiagnosticCategory): AppCheckDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
    default:
      return "error";
  }
}

function toDiagnostic(diagnostic: ts.Diagnostic): AppCheckDiagnostic {
  const result: AppCheckDiagnostic = {
    code: diagnostic.code,
    category: diagnosticCategory(diagnostic.category),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  };
  if (diagnostic.file && diagnostic.start !== undefined) {
    const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    result.file = diagnostic.file.fileName;
    result.line = position.line + 1;
    result.column = position.character + 1;
  }
  return result;
}

/** Typecheck exactly one app entry and its reachable imports. */
export function checkAppTypes(options: AppCheckOptions): AppCheckResult {
  const entry = resolve(options.entry);
  if (!existsSync(entry)) throw new Error(`PocketJS app check: entry not found: ${entry}`);
  const inheritedConfig = options.tsconfigPath ? resolve(options.tsconfigPath) : undefined;
  if (inheritedConfig && !existsSync(inheritedConfig)) {
    throw new Error(`PocketJS app check: tsconfig not found: ${inheritedConfig}`);
  }

  // Keep the ephemeral config beneath the app/config tree rather than the OS
  // temp directory. TypeScript resolves named `types` and config-relative
  // package paths from the generated config's ancestry.
  const temporaryParent = inheritedConfig ? dirname(inheritedConfig) : dirname(entry);
  const directory = mkdtempSync(resolve(temporaryParent, ".pocketjs-app-check-"));
  const generatedConfigPath = resolve(directory, "tsconfig.json");
  const declarationFiles = (options.declarationFiles ?? []).map((file) => resolve(file));
  for (const file of declarationFiles) {
    if (!existsSync(file)) throw new Error(`PocketJS app check: declaration file not found: ${file}`);
  }
  const tsconfig = configJson(entry, inheritedConfig, declarationFiles);
  writeFileSync(generatedConfigPath, tsconfig);

  try {
    const loaded = ts.readConfigFile(generatedConfigPath, (path) => readFileSync(path, "utf8"));
    const configDiagnostics = loaded.error ? [loaded.error] : [];
    const parsed = loaded.error
      ? undefined
      : ts.parseJsonConfigFileContent(
          loaded.config,
          ts.sys,
          dirname(generatedConfigPath),
          undefined,
          generatedConfigPath,
        );
    if (parsed) configDiagnostics.push(...parsed.errors);

    const program = parsed
      ? ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options })
      : undefined;
    const diagnostics = [
      ...configDiagnostics,
      ...(program ? ts.getPreEmitDiagnostics(program) : []),
    ].map(toDiagnostic);
    const checkedFiles = program
      ? program
          .getSourceFiles()
          .filter((file) => !file.isDeclarationFile)
          .map((file) => resolve(file.fileName))
          .sort()
      : [];

    return {
      ok: diagnostics.every((diagnostic) => diagnostic.category !== "error"),
      diagnostics,
      checkedFiles,
      artifacts: {
        tsconfig,
        ...(options.keepTemporaryFiles ? { directory } : {}),
      },
    };
  } finally {
    if (!options.keepTemporaryFiles) rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// A project with no tsconfig and no packages of its own
// ---------------------------------------------------------------------------

export interface ProjectCheckOptions {
  entry: string;
  /** The PocketJS root whose framework sources and installed packages the project compiles against. */
  frameworkRoot: string;
  /** The framework the project's manifest names. Default solid. */
  framework?: PocketFramework;
}

const PACKAGE = "@pocketjs/framework";

/**
 * `@pocketjs/framework[/…]` to the module the compiler resolves it to for
 * `framework`, read from the subpath registry: the bare form, and each
 * framework's prefixed form. A subpath a framework does not resolve is left
 * out, so importing it is the same error here as in the build.
 */
export function frameworkPaths(frameworkRoot: string, framework: PocketFramework = "solid"): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  const fileOf = (name: string, fw: PocketFramework): string | undefined => {
    const decl = SUBPATHS[name];
    const rel = decl === undefined ? undefined : typeof decl.file === "string" ? decl.file : decl.file[fw];
    return rel === undefined ? undefined : resolve(frameworkRoot, rel);
  };
  for (const name of Object.keys(SUBPATHS)) {
    const bare = fileOf(name, framework);
    if (bare) paths[name ? `${PACKAGE}/${name}` : PACKAGE] = [bare];
    for (const fw of POCKET_FRAMEWORKS) {
      const prefixed = fileOf(name, fw);
      if (prefixed) paths[name ? `${PACKAGE}/${fw}/${name}` : `${PACKAGE}/${fw}`] = [prefixed];
    }
  }
  return paths;
}

/**
 * Typecheck a project that carries no tsconfig and no node_modules: a game
 * made outside this repository, compiled against a PocketJS root. The
 * framework's subpaths resolve through the registry and every other package
 * (`solid-js`) through that root's node_modules, so the check reads nothing
 * of the project but its sources and writes nothing into it.
 *
 * It reports what the project's own files get wrong: an import that does not
 * exist, a `style` prop that is no PocketJS prop, a call with the wrong
 * arguments. A diagnostic inside the PocketJS root is not the author's and is
 * left out.
 */
export function checkProjectTypes(options: ProjectCheckOptions): AppCheckResult {
  const entry = resolve(options.entry);
  if (!existsSync(entry)) throw new Error(`PocketJS app check: entry not found: ${entry}`);
  const root = resolve(options.frameworkRoot);
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      lib: ["ES2022"],
      types: [],
      strict: true,
      noEmit: true,
      jsx: "preserve",
      allowImportingTsExtensions: true,
      skipLibCheck: true,
      baseUrl: root,
      paths: { ...frameworkPaths(root, options.framework), "*": [resolve(root, "node_modules/*")] },
    },
  };
  const tsconfig = JSON.stringify(config, null, 2) + "\n";
  const converted = ts.convertCompilerOptionsFromJson(config.compilerOptions, root);
  const declarations = [resolve(root, "framework/src/jsx.d.ts"), resolve(root, "framework/compiler/app-globals.d.ts")];
  const program = ts.createProgram({ rootNames: [entry, ...declarations], options: converted.options });
  const inside = (file: string | undefined): boolean => file !== undefined && resolve(file).startsWith(root + sep);
  const diagnostics = [...converted.errors, ...ts.getPreEmitDiagnostics(program)]
    .map(toDiagnostic)
    .filter((diagnostic) => !inside(diagnostic.file));
  return {
    ok: diagnostics.every((diagnostic) => diagnostic.category !== "error"),
    diagnostics,
    checkedFiles: program
      .getSourceFiles()
      .filter((file) => !file.isDeclarationFile && !inside(file.fileName))
      .map((file) => resolve(file.fileName))
      .sort(),
    artifacts: { tsconfig },
  };
}
