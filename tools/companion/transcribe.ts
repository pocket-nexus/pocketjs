// Speech to text for the console agent: one pocket-transcribe child per
// recording (tools/companion/macos/Transcribe.swift), fed the console's
// microphone PCM on stdin and read back as JSON lines. The helper comes from
// tools/companion/swift-helper.ts; $POCKET_AGENT_TRANSCRIBER overrides it.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { helperCommand } from "./swift-helper.ts";

export const TRANSCRIBE_SOURCE = join(import.meta.dir, "macos", "Transcribe.swift");

export interface TranscriptLine {
  text: string;
  final: boolean;
  error?: string;
}

/** The command that runs the helper, building it first when needed; null
 *  when this Mac cannot run one. */
export function transcriberCommand(storeDir: string, log?: (line: string) => void): Promise<string[] | null> {
  return helperCommand({ name: "pocket-transcribe", source: TRANSCRIBE_SOURCE, env: "POCKET_AGENT_TRANSCRIBER", flags: ["-parse-as-library"] }, storeDir, log);
}

/** One recording. write() PCM as it arrives, end() at the end of speech;
 *  `done` resolves with the final text ("" when nothing was recognized). */
export class Transcription {
  readonly done: Promise<string>;
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private latest = "";
  private ended = false;

  constructor(command: string[], rate: number, locale: string | undefined, onPartial: (text: string) => void, log?: (line: string) => void) {
    const args = [...command.slice(1), String(rate), ...(locale ? [locale] : [])];
    this.child = spawn(command[0], args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => {});
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log?.(`transcribe: ${text.slice(0, 300)}`);
    });
    this.done = new Promise<string>((resolve) => {
      let final: string | undefined;
      this.child.stdout.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (!line) continue;
          let parsed: TranscriptLine;
          try {
            parsed = JSON.parse(line) as TranscriptLine;
          } catch {
            continue;
          }
          if (parsed.error) log?.(`transcribe: ${parsed.error}`);
          const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
          if (parsed.final) final = text || this.latest;
          else if (text && text !== this.latest) {
            this.latest = text;
            onPartial(text);
          }
        }
      });
      this.child.on("exit", () => resolve(final ?? this.latest));
      this.child.on("error", (error) => {
        log?.(`transcribe: ${error.message}`);
        resolve("");
      });
    });
  }

  write(pcm: Uint8Array) {
    if (!this.ended) this.child.stdin.write(pcm);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.child.stdin.end();
  }

  kill() {
    this.ended = true;
    this.child.kill();
  }
}
