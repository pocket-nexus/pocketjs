// Compiler worker: the main page posts project files; replies with compiled modules, the style table and the pak.
import { compileProject, configure, CompileError, type CompileInput } from "./compiler.ts";

type Request = { id: number; type: "compile"; input: CompileInput } | { id: number; type: "configure"; fontBaseUrl?: string; assetBaseUrl?: string };

self.onmessage = async (event: MessageEvent<Request>) => {
  const msg = event.data;
  if (msg.type === "configure") {
    configure(msg);
    (self as unknown as Worker).postMessage({ id: msg.id, ok: true });
    return;
  }
  try {
    const output = await compileProject(msg.input);
    (self as unknown as Worker).postMessage({ id: msg.id, ok: true, output }, [output.pak]);
  } catch (e) {
    const diagnostic =
      e instanceof CompileError
        ? e.diagnostic
        : { file: msg.input.entry, message: e instanceof Error ? (e.stack ?? e.message) : String(e) };
    (self as unknown as Worker).postMessage({ id: msg.id, ok: false, diagnostic });
  }
};
