import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AppVariant } from "./compile-variant.ts";

export function evidenceDirectory(root: string, name: string): string {
  return join(root, ".pocket-build/validation/e2e", `${Date.now()}-${process.pid}-${name}`);
}

export interface CommandOptions {
  readonly root: string;
  readonly directory: string;
  readonly env?: NodeJS.ProcessEnv;
}
export type CommandRunner = (command: readonly string[], options: CommandOptions) => Promise<void>;

/** Save the command and its output even when a build exits by signal. */
export const runBuildCommand: CommandRunner = async (command, options) => {
  mkdirSync(options.directory, { recursive: true });
  const stdout = join(options.directory, "stdout.log");
  const stderr = join(options.directory, "stderr.log");
  const child = Bun.spawn([...command], {
    cwd: options.root, env: options.env ?? process.env,
    stdout: Bun.file(stdout), stderr: Bun.file(stderr),
  });
  const status = await child.exited;
  writeFileSync(join(options.directory, "command.json"), JSON.stringify({
    command, cwd: options.root, status, signal: child.signalCode,
  }, null, 2) + "\n");
  if (status !== 0 || child.signalCode) {
    throw new Error(`${command[2] ?? command[0]} failed (${child.signalCode ?? status}); see ${stderr}`);
  }
};

export function buildArtifact(receiptPath: string): string {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  if (receipt.schema !== "pocket-runtime-build/1" || receipt.success !== true || typeof receipt.artifact !== "string") {
    throw new Error(`successful native build receipt required: ${receiptPath}`);
  }
  if (!statSync(receipt.artifact).isFile()) throw new Error(`native artifact is not a file: ${receipt.artifact}`);
  return receipt.artifact;
}

/** Exercise the public compiler/package boundary before the native recipe:
 *  compile the `app` section of `config` (with the E2E `variant` in place of
 *  its identity and framework) into a package, then build the program from
 *  that package. */
export async function buildCaptureApplication(options: CommandOptions & {
  readonly target: "psp" | "vita";
  readonly config: string;
  readonly variant?: AppVariant;
  readonly nativeArgs?: readonly string[];
}, run: CommandRunner = runBuildCommand): Promise<string> {
  const root = resolve(options.root);
  const directory = resolve(options.directory);
  const bundle = join(directory, "application.pkb");
  const native = join(directory, "native");
  const cli = join(root, "tools/pocket.ts");
  await run([process.execPath, join(root, "tests/e2e/compile-variant.ts"), "compile", "--target", options.target,
    "--config", resolve(options.config), "--project-root", root,
    "--output", bundle, "--outdir", join(directory, "compiler"),
    "--plan-dir", join(directory, "plans"), ...(options.variant ? ["--variant", JSON.stringify(options.variant)] : [])],
  { ...options, root, directory: join(directory, "compile") });
  await run([process.execPath, cli, "build", "--target", options.target,
    "--bundle", bundle, "--outdir", native, "--", ...(options.nativeArgs ?? ["--capture"])],
  { ...options, root, directory: join(directory, "build") });
  return buildArtifact(join(native, "build-receipt.json"));
}
