// Programs the companion fetches for its owner instead of asking them to use a
// package manager: yt-dlp and ffmpeg for the YouTube service. They live in
// `<store>/tools/` and are found before any on PATH.
//
// yt-dlp is the project's own macOS build (one universal file) from its latest
// GitHub release, checked against that release's SHA2-256SUMS; YouTube
// changes its player often and yt-dlp follows, so "Update" fetches the latest
// again. ffmpeg is a pinned static build for this Mac's architecture, checked
// against a SHA-256 kept here.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const YT_DLP_RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
/** The release's build for this computer: one universal macOS file, or Linux by architecture. */
const YT_DLP_ASSET = process.platform === "darwin" ? "yt-dlp_macos" : process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";

/** ffmpeg 9.0.2 static builds (ffmpeg.martin-riedl.de), a zip holding one `ffmpeg`. */
const FFMPEG: Record<"arm64" | "x64", { url: string; sha256: string }> = {
  arm64: {
    url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
    sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
  },
  x64: {
    url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip",
    sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
  },
};

export interface ToolsInstall {
  state: "idle" | "installing" | "failed";
  /** What is being fetched, or why it failed. */
  message: string;
  /** Bytes received and expected of the current file; 0 when unknown. */
  received: number;
  total: number;
}

export class ManagedTools {
  readonly dir: string;
  private current: ToolsInstall = { state: "idle", message: "", received: 0, total: 0 };
  private running: Promise<void> | null = null;

  constructor(storeDir: string, private readonly log: (line: string) => void = () => {}) {
    this.dir = join(storeDir, "tools");
  }

  get ytDlp(): string | null {
    const path = join(this.dir, "yt-dlp");
    return existsSync(path) ? path : null;
  }

  get ffmpeg(): string | null {
    const path = join(this.dir, "ffmpeg");
    return existsSync(path) ? path : null;
  }

  get install(): ToolsInstall {
    return { ...this.current };
  }

  /** Fetch yt-dlp (the latest) and ffmpeg (when missing). Resolves when both
   *  are in place; a second call while one runs joins it. */
  start(): Promise<void> {
    this.running ??= this.fetchAll().finally(() => (this.running = null));
    return this.running;
  }

  private async fetchAll() {
    mkdirSync(this.dir, { recursive: true });
    try {
      this.set("Checking the latest yt-dlp");
      const sums = await (await this.get(`${YT_DLP_RELEASE}/SHA2-256SUMS`)).text();
      const expected = sums.split("\n").map((line) => line.trim().split(/\s+/)).find(([, name]) => name === YT_DLP_ASSET)?.[0];
      if (!expected) throw new Error(`the yt-dlp release lists no ${YT_DLP_ASSET}`);
      this.set("Downloading yt-dlp");
      this.place("yt-dlp", await this.download(`${YT_DLP_RELEASE}/${YT_DLP_ASSET}`, expected));
      if (!this.ffmpeg) {
        const build = FFMPEG[process.arch === "arm64" ? "arm64" : "x64"];
        this.set("Downloading ffmpeg");
        const zip = join(this.dir, "ffmpeg.zip");
        writeFileSync(zip, await this.download(build.url, build.sha256));
        const unpacked = join(this.dir, "ffmpeg.unpack");
        rmSync(unpacked, { recursive: true, force: true });
        const unzip = Bun.spawnSync(["/usr/bin/unzip", "-q", "-o", zip, "ffmpeg", "-d", unpacked]);
        rmSync(zip, { force: true });
        if (unzip.exitCode !== 0) throw new Error(`could not unpack ffmpeg: ${unzip.stderr.toString().trim()}`);
        chmodSync(join(unpacked, "ffmpeg"), 0o755);
        renameSync(join(unpacked, "ffmpeg"), join(this.dir, "ffmpeg"));
        rmSync(unpacked, { recursive: true, force: true });
      }
      this.current = { state: "idle", message: "", received: 0, total: 0 };
      this.log(`tools: yt-dlp and ffmpeg ready in ${this.dir}`);
    } catch (error) {
      this.current = { state: "failed", message: (error as Error).message, received: 0, total: 0 };
      this.log(`tools: ${(error as Error).message}`);
      throw error;
    }
  }

  private set(message: string) {
    this.current = { state: "installing", message, received: 0, total: 0 };
  }

  private async get(url: string): Promise<Response> {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(600_000) });
    if (!response.ok || !response.body) throw new Error(`${new URL(url).hostname} answered ${response.status}`);
    return response;
  }

  /** The file at `url`, counted into the install's progress, refused unless its SHA-256 is `sha256`. */
  private async download(url: string, sha256: string): Promise<Uint8Array> {
    const response = await this.get(url);
    const total = Number(response.headers.get("content-length") ?? 0);
    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      this.current = { ...this.current, received, total };
    }
    const bytes = Buffer.concat(chunks);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== sha256.toLowerCase()) throw new Error(`${new URL(url).pathname.split("/").pop()} did not match its checksum`);
    return bytes;
  }

  /** Write an executable through a temp file so a running copy is never half replaced. */
  private place(name: string, bytes: Uint8Array) {
    const tmp = join(this.dir, `${name}.download`);
    writeFileSync(tmp, bytes, { mode: 0o755 });
    renameSync(tmp, join(this.dir, name));
  }
}
