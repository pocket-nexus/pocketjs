import { join } from "node:path";
import { validImeKeys, validImeBrowse } from "../../contracts/spec/ime.ts";

/** Supervisor-owned native engine. Socket workers may restart without owning
 * or orphaning this process. Each query still replays an independent session. */
export class RimeEngine {
  private child?: ReturnType<typeof Bun.spawn>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private buffered = "";
  private serial = Promise.resolve();
  private pending = 0;
  private stopped = false;
  constructor(readonly directory: string) {}
  compose(payload: string, browse = false): Promise<string> {
    const input = JSON.parse(payload);
    if (browse ? !validImeBrowse(input) : !validImeKeys(input)) return Promise.reject(new Error("Invalid IME transcript"));
    const keys: number[] = browse ? input.keys : input;
    if (this.stopped || this.pending >= 16) return Promise.reject(new Error("IME engine busy"));
    this.pending++;
    const result = this.serial.then(async () => {
      const timeout = setTimeout(() => this.reset(), 5000);
      try {
        if (this.stopped) throw new Error("IME engine closed");
        if (!this.child) {
          this.child = Bun.spawn([join(this.directory, "pocket-rime"), this.directory], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
          this.reader = (this.child.stdout as ReadableStream<Uint8Array>).getReader();
        }
        const decoder = new TextDecoder();
        (this.child.stdin as import("bun").FileSink).write(`${keys.join(",")}${browse ? `;${input.offset}` : ""}\n`);
        (this.child.stdin as import("bun").FileSink).flush();
        while (!this.buffered.includes("\n")) {
          const chunk = await this.reader!.read();
          if (chunk.done) throw new Error("Rime engine exited");
          this.buffered += decoder.decode(chunk.value, { stream: true });
          if (this.buffered.length > 8192) throw new Error("Rime output exceeds budget");
        }
        const end = this.buffered.indexOf("\n"), result = this.buffered.slice(0, end);
        this.buffered = this.buffered.slice(end + 1);
        const snapshot = JSON.parse(result);
        if (snapshot.error) throw new Error(snapshot.error);
        return result;
      } catch (error) { this.reset(); throw error; }
      finally { clearTimeout(timeout); this.pending--; }
    });
    this.serial = result.then(() => {}, () => {});
    return result;
  }
  private reset() { this.child?.kill(); this.child = undefined; this.reader = undefined; this.buffered = ""; }
  close() { this.stopped = true; this.reset(); }
}
