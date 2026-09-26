import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One publisher owns a library. Provider readers use independent SQLite handles. */
export function lockLibrary(root: string): () => void {
  mkdirSync(root, { recursive: true });
  const path = join(root, ".relay.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try { fd = openSync(path, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number;
      try { pid = JSON.parse(readFileSync(path, "utf8")).pid; }
      catch { throw Error(`Invalid relay lock at ${path}; check that the old relay has stopped`); }
      if (!Number.isInteger(pid) || pid < 1) throw Error("Invalid relay lock PID");
      try { process.kill(pid, 0); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") { unlinkSync(path); continue; }
      }
      throw Error(`A relay already owns this library (PID ${pid})`);
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); } finally { closeSync(fd); }
    return () => { try { unlinkSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; } };
  }
  throw Error("Could not acquire relay library lock");
}
