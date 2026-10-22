import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

export interface MtpFolder {
  readonly storage: string;
  readonly id: number;
  readonly name: string;
  readonly depth: number;
}

export function parseMtpFolders(output: string): readonly MtpFolder[] {
  const folders: MtpFolder[] = [];
  let storage: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    const storageMatch = line.match(/^Storage:\s*(.+?)\s*$/);
    if (storageMatch) {
      storage = storageMatch[1]!;
      continue;
    }
    const folderMatch = line.match(/^(\d+)\t( *)(.+?)\s*$/);
    if (!storage || !folderMatch) continue;
    folders.push({
      storage,
      id: Number(folderMatch[1]),
      name: folderMatch[3]!,
      depth: Math.floor(folderMatch[2]!.length / 2),
    });
  }
  return folders;
}

export function selectMtpFolder(
  folders: readonly MtpFolder[],
  storage: string,
  name: string,
): MtpFolder {
  const matches = folders.filter(
    (folder) => folder.storage === storage && folder.depth === 0 && folder.name === name,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one top-level ${storage}/${name} MTP folder, found ${matches.length}`,
    );
  }
  return matches[0]!;
}

export function parseMtpSendFileId(output: string): number {
  const match = output.match(/^New file ID:\s*(\d+)\s*$/m);
  const id = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("mtp-sendfile did not report a new file ID");
  }
  return id;
}

export function isExpectedMtpDevice(
  output: string,
  expected: { vendorId: string; productId: string; name: string },
): boolean {
  const devices = [...output.matchAll(
    /Device\s+\d+\s+\(VID=([a-f0-9]+)\s+and\s+PID=([a-f0-9]+)\)\s+is\s+a\s+(.+?)\.\s*$/gim,
  )];
  return devices.length === 1 &&
    devices[0]?.[1]?.toLowerCase() === expected.vendorId.toLowerCase() &&
    devices[0]?.[2]?.toLowerCase() === expected.productId.toLowerCase() &&
    devices[0]?.[3]?.toLowerCase().includes(expected.name.toLowerCase());
}

export function sanitizeDeviceOutput(output: string): string {
  return output
    .replace(
      /\b(serial(?:\s+number)?|imei|sn)(\s*[:=]\s*)\S+/gi,
      "$1$2[redacted]",
    )
    .replace(/\b\d{14,16}\b/g, "[redacted]")
    .replace(/\/dev\/(?:cu|tty)\.usbmodem\S+/g, "[redacted-device]")
    .replace(/[ \t]+$/gm, "");
}

export function safeAtCommands(): readonly string[] {
  return ["AT", "ATI", "AT+CGMM", "AT+CGMR"] as const;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function requireSuccess(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  timeoutMs: number,
  attempts = 1,
): Promise<CommandResult> {
  let last: CommandResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await runner(command, args, timeoutMs);
    if (result.exitCode === 0) return result;
    last = result;
    if (attempt < attempts) await Bun.sleep(500 * attempt);
  }
  const detail = sanitizeDeviceOutput(last?.stderr || last?.stdout || "").trim();
  throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
}

export interface DeploySisOptions {
  readonly storage: string;
  readonly folder: string;
  readonly vendorId: string;
  readonly productId: string;
  readonly deviceName: string;
  readonly timeoutMs?: number;
}

export interface DeployedSis {
  readonly localName: string;
  readonly fileId: number;
  readonly folderId: number;
  readonly sha256: string;
}

/**
 * Copy one SIS over MTP and read it back by object id before reporting
 * success. This intentionally does not install, launch, replace, or delete
 * anything on the phone.
 */
export async function deploySis(
  sis: string,
  runner: CommandRunner,
  options: DeploySisOptions,
): Promise<DeployedSis> {
  if (!existsSync(sis)) throw new Error(`SIS not found: ${sis}`);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const foldersResult = await requireSuccess(runner, "mtp-folders", [], timeoutMs, 3);
  const discovery = `${foldersResult.stdout}\n${foldersResult.stderr}`;
  if (!isExpectedMtpDevice(discovery, {
    vendorId: options.vendorId,
    productId: options.productId,
    name: options.deviceName,
  })) {
    throw new Error(
      `expected exactly one ${options.deviceName} MTP device ` +
        `(VID=${options.vendorId}, PID=${options.productId})`,
    );
  }
  const target = selectMtpFolder(
    parseMtpFolders(discovery),
    options.storage,
    options.folder,
  );

  const sent = await requireSuccess(runner, "mtp-sendfile", [sis, String(target.id)], timeoutMs);
  const fileId = parseMtpSendFileId(`${sent.stdout}\n${sent.stderr}`);
  const temporary = mkdtempSync(join(tmpdir(), "pocketjs-symbian-mtp-"));
  const readback = join(temporary, basename(sis));
  try {
    await requireSuccess(runner, "mtp-getfile", [String(fileId), readback], timeoutMs, 3);
    const [localHash, remoteHash] = await Promise.all([sha256(sis), sha256(readback)]);
    if (localHash !== remoteHash) {
      throw new Error(
        `MTP readback SHA-256 mismatch (${localHash} local, ${remoteHash} device)`,
      );
    }
    return {
      localName: basename(sis),
      fileId,
      folderId: target.id,
      sha256: localHash,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
