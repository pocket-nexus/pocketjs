// Native source acquisition has no guest compiler or manifest dependency.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCommand(
  program: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): CommandResult {
  const result = Bun.spawnSync({
    cmd: [program, ...args],
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.success ? 0 : result.exitCode || 1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

export function mustRunCommand(
  label: string,
  program: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = runCommand(program, args, cwd, env);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `${label}: ${program} ${args.join(" ")} failed (${result.exitCode})${
        detail ? `:\n${detail}` : ""
      }`,
    );
  }
  return result.stdout.trim();
}

export interface QuickJsPin {
  readonly version: string;
  readonly repository: string;
  readonly revision: string;
}

export interface QuickJsCheckout {
  readonly root: string;
  /** `libquickjs-sys/embed/quickjs` — the C sources both hosts compile. */
  readonly source: string;
  readonly staticFunctions: string;
}

export function quickJsCheckout(root: string): QuickJsCheckout {
  return {
    root,
    source: join(root, "libquickjs-sys/embed/quickjs"),
    staticFunctions: join(root, "libquickjs-sys/embed/static-functions.c"),
  };
}

/** The checkout is usable only at the pinned revision with a clean tree. */
export function quickJsCheckoutStatus(
  root: string,
  pin: QuickJsPin,
): { ok: boolean; detail: string } {
  if (!existsSync(join(root, ".git"))) {
    return { ok: false, detail: root };
  }
  const revision = runCommand("git", ["-C", root, "rev-parse", "HEAD"], root);
  const changes = runCommand(
    "git",
    ["-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
    root,
  );
  const versionPath = join(quickJsCheckout(root).source, "VERSION");
  const version = existsSync(versionPath)
    ? readFileSync(versionPath, "utf8").trim()
    : "";
  const ok =
    revision.exitCode === 0 &&
    revision.stdout.trim() === pin.revision &&
    changes.exitCode === 0 &&
    changes.stdout.trim() === "" &&
    version === pin.version;
  return {
    ok,
    detail: `${root} (${revision.stdout.trim() || "missing"}, ${version || "no VERSION"})`,
  };
}

export function ensureQuickJsCheckout(
  label: string,
  root: string,
  pin: QuickJsPin,
): void {
  const status = quickJsCheckoutStatus(root, pin);
  if (status.ok) return;
  if (existsSync(root)) {
    throw new Error(
      `${label}: refusing to replace an unverified QuickJS directory: ${status.detail}`,
    );
  }
  mkdirSync(dirname(root), { recursive: true });
  mustRunCommand(
    label,
    "git",
    ["clone", "--filter=blob:none", "--no-checkout", pin.repository, root],
    dirname(root),
  );
  mustRunCommand(
    label,
    "git",
    ["-C", root, "checkout", "--detach", pin.revision],
    root,
  );
  const verified = quickJsCheckoutStatus(root, pin);
  if (!verified.ok) {
    throw new Error(`${label}: QuickJS verification failed: ${verified.detail}`);
  }
}

