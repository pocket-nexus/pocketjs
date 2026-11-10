// A device's link directory reached over ftpd, as the storage Hub's setup
// writes a pairing through (docs/POCKET-LINK.md §3.2). Every operation is one
// `curl` run, the way the development tool reached ftpd for its key file: 3 s to
// connect, 15 s for a read or a listing, 30 s for a write, no proxy.
//
// A read tells its three outcomes apart, as §3.2 step 3 needs: curl's exit
// codes 78 (the server answered "no such file" to SIZE or to RETR; curl 8
// stops at the SIZE) and 9 (it refused to enter the folder, which a card that
// never held the folder answers) are "absent"; any other failure is a failed
// read, which says nothing about the file. A delete is confirmed by a read
// that answers "absent".

import type { SetupStorage } from "./hub.ts";
import type { ReadOutcome } from "./pairing.ts";

const CURL_NO_SUCH_FILE = 78;
const CURL_NO_SUCH_FOLDER = 9;
/** Paths this storage sends in a URL and in FTP commands: no byte that could
 *  end one, and no segment that leaves the link directory. */
const SEGMENTS = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const safePath = (path: string) => SEGMENTS.test(path) && !path.split("/").some((segment) => segment === "." || segment === "..");

export interface CurlResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
}
export type CurlRunner = (args: string[], stdin?: Uint8Array) => Promise<CurlResult>;

export interface FtpStorageOptions {
  host: string;
  /** ftpd's port; the 3DS's ftpd shows 5000. */
  port?: number;
  /** The link directory below the FTP root. The 3DS: `pocketjs/link` (`sdmc:/pocketjs/link/`). */
  root?: string;
  /** Test seam: runs curl. */
  run?: CurlRunner;
}

export interface FtpStorage extends SetupStorage {
  /** Connects once and returns this computer's address on that connection:
   *  the address the device reaches Hub at (§3.2 step 3). Throws when ftpd does not answer. */
  localAddress(): Promise<string>;
}

async function runCurl(args: string[], stdin?: Uint8Array): Promise<CurlResult> {
  const child = Bun.spawn(["curl", ...args], { stdin: stdin === undefined ? "ignore" : new Blob([stdin.slice().buffer as ArrayBuffer]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).arrayBuffer(), new Response(child.stderr).text(), child.exited]);
  return { exitCode, stdout: new Uint8Array(stdout), stderr: stderr.trim() };
}

export class FtpError extends Error {
  constructor(what: string, readonly result: CurlResult) {
    super(`${what}: ${result.stderr || `curl exited ${result.exitCode}`}`);
  }
}

export function ftpStorage(options: FtpStorageOptions): FtpStorage {
  const port = options.port ?? 5000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("the FTP port is 1 to 65535");
  if (!/^[A-Za-z0-9.-]+$/.test(options.host)) throw new Error("the FTP host is an address or a host name");
  const root = (options.root ?? "pocketjs/link").replace(/^\/+|\/+$/g, "");
  if (root !== "" && !safePath(root)) throw new Error("the link directory holds letters, digits, '.', '_', '-' and '/'");
  const run = options.run ?? runCurl;
  const base = `ftp://${options.host}:${port}`;
  const common = (seconds: number) => ["--silent", "--show-error", "--noproxy", "*", "--connect-timeout", "3", "--max-time", String(seconds)];
  const remote = (path: string) => {
    if (!safePath(path)) throw new Error(`not a path this storage writes: ${path}`);
    return root === "" ? `/${path}` : `/${root}/${path}`;
  };

  async function read(path: string): Promise<ReadOutcome> {
    const result = await run([...common(15), `${base}${remote(path)}`]);
    if (result.exitCode === 0) return { kind: "file", text: new TextDecoder().decode(result.stdout) };
    if (result.exitCode === CURL_NO_SUCH_FILE || result.exitCode === CURL_NO_SUCH_FOLDER) return { kind: "absent" };
    return { kind: "failed" };
  }

  return {
    async localAddress() {
      const result = await run([...common(15), "--list-only", "--output", "/dev/null", "--write-out", "%{local_ip}", `${base}/`]);
      const address = new TextDecoder().decode(result.stdout).trim();
      if (result.exitCode !== 0 || address === "") throw new FtpError(`ftpd did not answer at ${options.host}:${port}`, result);
      return address;
    },
    read,
    async list(dir) {
      const result = await run([...common(15), "--list-only", `${base}${remote(dir)}/`]);
      if (result.exitCode === CURL_NO_SUCH_FILE || result.exitCode === CURL_NO_SUCH_FOLDER) return [];
      if (result.exitCode !== 0) throw new FtpError(`${dir}/ could not be listed`, result);
      return new TextDecoder()
        .decode(result.stdout)
        .split("\n")
        .map((line) => line.replace(/\r$/, ""))
        .map((line) => line.slice(line.lastIndexOf("/") + 1))
        .filter((name) => name !== "" && name !== "." && name !== "..");
    },
    async write(path, text) {
      const result = await run([...common(30), "--ftp-create-dirs", "--upload-file", "-", `${base}${remote(path)}`], new TextEncoder().encode(text));
      if (result.exitCode !== 0) throw new FtpError(`${path} could not be written`, result);
    },
    async remove(path) {
      // "*" lets curl go on when the server refuses the DELE, which it does for
      // a file that is not there; the read below says whether the file is gone.
      const result = await run([...common(15), "--list-only", "--output", "/dev/null", "--quote", `*DELE ${remote(path)}`, `${base}/`]);
      if (result.exitCode !== 0) throw new FtpError(`${path} could not be deleted`, result);
      const after = await read(path);
      if (after.kind !== "absent") throw new FtpError(`${path} is still there after its delete`, { exitCode: 0, stdout: new Uint8Array(0), stderr: after.kind === "failed" ? "the read after the delete failed" : "the server kept the file" });
    },
    async rename(from, to) {
      const result = await run([...common(15), "--list-only", "--output", "/dev/null", "--quote", `RNFR ${remote(from)}`, "--quote", `RNTO ${remote(to)}`, `${base}/`]);
      if (result.exitCode !== 0) throw new FtpError(`${from} could not be renamed`, result);
    },
  };
}
