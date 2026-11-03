// A program a service keeps running: started, its output read line by line,
// started again when it exits — a second later, then twice as long each time
// up to `maxBackoffMs`, back to a second once a run has lasted
// `healthyAfterMs`. `argv` and `env` are read at each start, so a service can
// change what it runs (another build, another key) and `restart()` it.
//
// A line's text goes to `onLine` and never to the log by default: a vendor's
// program may print an account name or a key it was given.
//
// The program does not outlive its supervisor. With `pidFile` each start
// first stops the run the file names, when that process is still alive and
// is the same program (a supervisor that crashed, or whose service manager
// kills only its main process, leaves one holding a port); and the
// supervisor's own exit stops it.

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

/** the programs running now, stopped when the supervisor exits */
const live = new Set<Supervised>();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const stopAll = () => {
    for (const program of live) program.stop();
  };
  // a supervisor's own signal handling is its own: one that exits through
  // process.exit() stops its programs here, and pidFile covers the rest
  process.once("exit", stopAll);
}

/** The command a live process runs, or null when it is gone. */
function commandOf(pid: number): string | null {
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
  } catch {
    const ps = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)]);
    return ps.exitCode === 0 ? new TextDecoder().decode(ps.stdout).trim() : null;
  }
}

/** Stop the run `pidFile` names when it is still `program`. */
function stopEarlier(pidFile: string, program: string, log: ((line: string) => void) | undefined, name: string) {
  let pid = 0;
  let recorded = "";
  try {
    [pid, recorded] = (([p, r]) => [Number(p), r ?? ""])(readFileSync(pidFile, "utf8").split("\n")) as [number, string];
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  const running = commandOf(pid);
  if (running === null) return;
  // the same program: its path, or the name ps shows for it
  if (running !== program && running !== recorded && basename(running) !== basename(program).slice(0, 15) && basename(running) !== basename(program)) return;
  log?.(`${name}: stopping the run an earlier supervisor left (pid ${pid})`);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  for (let i = 0; i < 40 && commandOf(pid) !== null; i++) Bun.sleepSync(50);
  if (commandOf(pid) !== null) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone between the check and the kill
    }
  }
}

export interface SuperviseOptions {
  name: string;
  /** where the running program's pid is kept, for the next supervisor to stop it */
  pidFile?: string;
  /** the program and its arguments, read at each start; null starts nothing */
  argv: () => string[] | null;
  env?: () => Record<string, string | undefined>;
  onLine?: (line: string, stream: "stdout" | "stderr") => void;
  onExit?: (code: number | null) => void;
  log?: (line: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  healthyAfterMs?: number;
}

export class Supervised {
  private child: ReturnType<typeof Bun.spawn> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wanted = false;
  private backoff: number;
  private startedAt = 0;
  /** how many times it has been started */
  starts = 0;

  constructor(private readonly options: SuperviseOptions) {
    this.backoff = options.minBackoffMs ?? 1_000;
    hookExit();
  }

  get running(): boolean {
    return this.child !== null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start() {
    this.wanted = true;
    if (this.child || this.timer) return;
    const argv = this.options.argv();
    if (!argv?.length) return;
    if (this.options.pidFile) stopEarlier(this.options.pidFile, argv[0]!, this.options.log, this.options.name);
    const env = this.options.env ? { ...process.env, ...this.options.env() } : process.env;
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: env as Record<string, string> });
    } catch (error) {
      this.options.log?.(`${this.options.name}: could not start: ${(error as Error).message}`);
      this.again();
      return;
    }
    this.child = child;
    this.starts++;
    if (this.options.pidFile) {
      try {
        writeFileSync(this.options.pidFile, `${child.pid}\n${argv[0]}\n`, { mode: 0o600 });
      } catch {
        // a missing folder: only the next supervisor's check is lost
      }
    }
    live.add(this);
    this.startedAt = Date.now();
    void this.read(child.stdout as ReadableStream<Uint8Array>, "stdout");
    void this.read(child.stderr as ReadableStream<Uint8Array>, "stderr");
    void child.exited.then((code) => {
      if (this.child !== child) return;
      this.child = null;
      live.delete(this);
      this.options.onExit?.(code);
      if (!this.wanted) return;
      if (Date.now() - this.startedAt >= (this.options.healthyAfterMs ?? 60_000)) this.backoff = this.options.minBackoffMs ?? 1_000;
      this.options.log?.(`${this.options.name}: stopped (${code}); starting again in ${Math.round(this.backoff / 1000)} s`);
      this.again();
    });
  }

  private again() {
    if (!this.wanted || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start();
    }, this.backoff);
    this.backoff = Math.min(this.options.maxBackoffMs ?? 30_000, this.backoff * 2);
  }

  private async read(stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    let rest = "";
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        rest += decoder.decode(chunk, { stream: true });
        let at: number;
        while ((at = rest.indexOf("\n")) >= 0) {
          const line = rest.slice(0, at).replace(/\r$/, "");
          rest = rest.slice(at + 1);
          if (line) this.options.onLine?.(line, name);
        }
      }
    } catch {
      // the program's end closed the pipe
    }
    if (rest) this.options.onLine?.(rest, name);
  }

  stop() {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    this.child = null;
    live.delete(this);
    child?.kill();
  }

  /** Stop it and start it again now, with what argv and env answer now. */
  restart() {
    this.stop();
    this.backoff = this.options.minBackoffMs ?? 1_000;
    this.start();
  }
}
