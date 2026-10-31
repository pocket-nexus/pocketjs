// The agent loop on the handheld: a plain synchronous loop in QuickJS. It keeps
// the conversation as JSON, calls the host for one model turn at a time, runs
// the tool calls, and trims what the model has already seen.

declare const host: {
  status(text: string): void;
  line(kind: string, text: string): void;
  model(request: string): string;
  listFiles(): string;
  readFile(path: string): string;
  writeFile(path: string, content: string): string;
  editFile(path: string, old: string, updated: string): string;
  runGame(options: string): string;
  forgetImage(name: string): void;
  finish(meta: string): void;
  cancelled(): boolean;
};

interface Item { type?: string; role?: string; content?: any; name?: string; call_id?: string; arguments?: string; output?: string; [key: string]: any }

const MAX_TURNS = 40;
const KEEP_RECENT_ITEMS = 16;
const KEEP_SHOT_MESSAGES = 1;

const tools = [
  fn("list_files", "List the files in the game's directory.", {}, []),
  fn("read_file", "Read a text file from the game's directory.", { path: { type: "string" } }, ["path"]),
  fn("write_file", "Create or replace a file in the game's directory. Syntax errors in TypeScript come back in the reply.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  fn("edit_file", "Replace the single occurrence of `old` in a file with `new`.", { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, ["path", "old", "new"]),
  fn("run_game", "Run main.ts on the console's screen at 60 ticks per second with scripted buttons. Returns errors, console logs, entity count and screenshots from the ticks you name, which arrive in the next message.", {
    ticks: { type: "integer", description: "How long to run, at most 600. Default 180." },
    inputs: { type: "array", description: "Buttons to hold.", items: { type: "object", properties: { button: { type: "string", enum: ["up", "down", "left", "right", "a", "b", "x", "y", "l", "r", "start", "select"] }, from: { type: "integer" }, to: { type: "integer" } }, required: ["button", "from", "to"] } },
    screenshots: { type: "array", description: "Ticks to capture, at most 3. Default: the last tick.", items: { type: "integer" } },
  }, []),
  fn("finish", "Put the game on the shelf. Call this only after run_game shows it working.", {
    title: { type: "string", description: "Short title, in the language the player used." },
    tagline: { type: "string", description: "One line under the title." },
    summary: { type: "string", description: "What the game is and how it is controlled, for the player and for a later edit." },
    color: { type: "string", description: "The case's color as #rrggbb." },
  }, ["title", "tagline", "summary", "color"]),
];

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
  return { type: "function", name, description, strict: false, parameters: { type: "object", properties, required } };
}

function instructions(types: string): string {
  return `You make small 3D games that run on this handheld, a TrimUI Smart Pro: 1280x720 screen, d-pad, left and right sticks, a b x y, l r, triggers, start, select. You are running on the handheld itself.

The game is TypeScript in QuickJS with no DOM, canvas, network or timers. Rust draws everything. main.ts must default-export game({...}) and may import other relative .ts files in its directory. Types are stripped, not checked, so write carefully.

The whole API is this module:

${types}

Conventions:
- Write readable, formatted code with one statement per line: you will edit it later with edit_file.
- Everything is built from shapes with flat colors: compose characters and scenery from several boxes, spheres, cones and cylinders. Choose a clear palette and a sky color. Give things that move shadow: true and call scene.ground with the floor's height.
- Up is +y. The camera sits at a 3/4 angle by default: set it with camera.look or camera.follow every frame so the play area fills the screen.
- update(dt) runs at a fixed 60 Hz. Use rand, never Math.random or Date. Keep at most about 1500 entities alive; reuse entities instead of spawning each frame.
- Draw score and prompts with hud.text in draw(); the HUD screen is 1280x720, text size 32 reads well. Show how to play on a title screen, and let a button restart after losing.
- In-game text may use the player's language: the font covers Chinese.
- Give feedback with sfx and fx.burst.

Method: write main.ts, then call run_game with inputs that exercise the controls and screenshots that show the action. Look at the screenshots. Fix what the errors, logs or pictures show. A blank or dull picture means the game is not done. When it plays and looks right, call finish. Be economical: a good game usually takes 2 to 5 runs. Reply in the player's language in any text you write, in one or two short sentences.`;
}

function userMessage(text: string): Item {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

function brief(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}

/** Tool calls and results the model has acted on shrink to a stub; old screenshots go. */
function compact(input: Item[]): void {
  const shotMessages = input.filter((item) => item.pocketShots);
  for (const message of shotMessages.slice(0, -KEEP_SHOT_MESSAGES)) {
    for (const name of message.pocketShots as string[]) host.forgetImage(name);
    message.content = [{ type: "input_text", text: "(earlier screenshots removed)" }];
    delete message.pocketShots;
  }
  const edge = input.length - KEEP_RECENT_ITEMS;
  for (let i = 1; i < edge; i++) {
    const item = input[i]!;
    if (item.type === "function_call" && item.arguments && item.arguments.length > 240) {
      const args = safeParse(item.arguments);
      item.arguments = JSON.stringify({ path: args.path, elided: `${item.arguments.length} characters; read the file for its current content` });
    } else if (item.type === "function_call_output" && item.output && item.output.length > 400) {
      item.output = item.output.slice(0, 240) + "\n(elided)";
    }
  }
}

function safeParse(text: string): any {
  try { return JSON.parse(text) ?? {}; } catch { return {}; }
}

function outgoing(input: Item[]): Item[] {
  return input.map((item) => {
    if (!item.pocketShots) return item;
    const { pocketShots: _, ...rest } = item;
    return rest;
  });
}

let finished = false;

function callTool(name: string, args: any, input: Item[]): string {
  switch (name) {
    case "list_files":
      return host.listFiles();
    case "read_file":
      host.status(`reading ${args.path}`);
      return host.readFile(String(args.path));
    case "write_file": {
      const content = String(args.content ?? "");
      host.line("file", `${args.path}  ${content.split("\n").length} lines`);
      return host.writeFile(String(args.path), content);
    }
    case "edit_file":
      host.line("file", `${args.path}  edited`);
      return host.editFile(String(args.path), String(args.old), String(args.new));
    case "run_game": {
      host.line("run", `testing for ${args.ticks ?? 180} ticks`);
      const report = safeParse(host.runGame(JSON.stringify(args)));
      const images: string[] = report.images ?? [];
      delete report.images;
      if (report.ok === false) host.line("error", brief(String(report.error ?? "run failed"), 200));
      else host.line("run", `ok, ${report.entities ?? 0} entities, ${report.fps ?? "?"} fps`);
      if (images.length) {
        const message = userMessage(`Screenshots from run_game at ticks ${JSON.stringify(report.shotTicks ?? [])}.`);
        for (const image of images) message.content.push({ image_ref: image, detail: "high" });
        message.pocketShots = images;
        input.push({ pocketDeferred: message } as Item);
      }
      return JSON.stringify(report);
    }
    case "finish":
      host.line("done", String(args.title));
      host.finish(JSON.stringify(args));
      finished = true;
      return "on the shelf";
    default:
      return `ERROR: no tool named ${name}`;
  }
}

function main(briefJson: string): void {
  const task = JSON.parse(briefJson) as { prompt: string; previousSummary?: string | null; files: string; types: string };
  const system = instructions(task.types);
  const opening = task.previousSummary
    ? `The player wants a change to the existing game.\nWhat it is now: ${task.previousSummary}\nFiles:\n${task.files}\nThe player said: ${task.prompt}`
    : `Make this game. The player said: ${task.prompt}`;
  const input: Item[] = [userMessage(opening)];
  let inputTokens = 0, outputTokens = 0;

  for (let turn = 0; turn < MAX_TURNS && !finished; turn++) {
    if (host.cancelled()) return;
    host.status(turn === 0 ? "thinking" : `thinking, turn ${turn + 1}`);
    compact(input);
    const reply = JSON.parse(host.model(JSON.stringify({ instructions: system, input: outgoing(input), tools, tool_choice: "auto", parallel_tool_calls: false, include: [] })));
    if (reply.error) throw new Error(reply.error);
    inputTokens = reply.input; outputTokens += reply.output;
    const calls: Item[] = [];
    for (const item of reply.items as Item[]) {
      if (item.type === "message") {
        const text = (item.content ?? []).map((part: any) => part.text ?? "").join("");
        if (text) host.line("say", brief(text, 240));
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      } else if (item.type === "function_call") {
        const call = { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments };
        input.push(call);
        calls.push(call);
      }
    }
    if (calls.length === 0) {
      input.push(userMessage("Continue: use the tools, and call finish when the game works."));
      continue;
    }
    for (const call of calls) {
      if (host.cancelled()) return;
      const output = callTool(call.name!, safeParse(call.arguments ?? "{}"), input);
      input.push({ type: "function_call_output", call_id: call.call_id, output });
    }
    // Screenshots follow the tool result they belong to.
    for (let i = input.length - 1; i >= 0; i--) {
      const deferred = input[i]!.pocketDeferred as Item | undefined;
      if (deferred) {
        input.splice(i, 1);
        input.push(deferred);
      }
    }
  }
  console.log(`tokens: context ${inputTokens}, generated ${outputTokens}`);
  if (!finished) throw new Error(`no working game after ${MAX_TURNS} turns`);
}

(globalThis as any).main = main;
