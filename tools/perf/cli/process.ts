import { createHash } from "node:crypto";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export function runCommand(
  argv: readonly string[],
  options: { readonly cwd: string; readonly stdin?: Uint8Array } ,
): CommandResult {
  const child = Bun.spawnSync(argv as string[], {
    cwd: options.cwd,
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: child.exitCode,
    stdout: child.stdout,
    stderr: child.stderr,
  };
}

export function commandText(
  argv: readonly string[],
  cwd: string,
  options: { readonly allowFailure?: boolean } = {},
): string {
  const result = runCommand(argv, { cwd });
  if (result.exitCode !== 0 && !options.allowFailure) {
    const detail = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`${argv.join(" ")} failed (${result.exitCode})${detail ? `: ${detail}` : ""}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot encode a non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  throw new Error(`cannot encode ${typeof value} as canonical JSON`);
}
