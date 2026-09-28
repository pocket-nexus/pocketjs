// Reading progress uses the existing per-app filesystem where mounted.
// 3DS supplies a bounded state blob because its filesystem module is absent.
import { fsHost, file, write, renameSync } from "@pocketjs/framework/fs";
import { utf8Length } from "./document.ts";
import { emptyProgress, parseProgress, type Progress } from "./progress.ts";

interface StateHost { read(): string; write(text: string): number }
const stateHost = () => (globalThis as { state?: StateHost }).state;
export function stateAvailable(): boolean {
  return fsHost() !== null || typeof stateHost()?.write === "function";
}
function readState(): string {
  try {
    if (fsHost()) return file("state.json").exists() ? file("state.json").text() : "";
    return stateHost()?.read() ?? "";
  } catch { return ""; }
}
function writeState(text: string): boolean {
  if (utf8Length(text) > 64 * 1024) return false;
  try {
    if (fsHost()) { write("state.json.partial", text); renameSync("state.json.partial", "state.json"); return true; }
    return stateHost()?.write(text) === 0;
  } catch { return false; }
}

let device = "";
export function deviceIdentity(): string {
  if (!device) device = `reader-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
  return device;
}

export function loadProgress(): Progress {
  const raw = readState();
  if (raw) try {
    const value = JSON.parse(raw);
    if (typeof value.device === "string" && /^[a-z0-9-]{1,64}$/.test(value.device)) device = value.device;
  } catch { /* Legacy or corrupt saves still recover through parseProgress. */ }
  return raw ? parseProgress(raw) : emptyProgress();
}

export function saveProgress(progress: Progress): boolean {
  return writeState(JSON.stringify({ ...progress, device: deviceIdentity() }));
}
