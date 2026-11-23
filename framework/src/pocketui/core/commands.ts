// PocketUI core/commands.ts — what an application can do, declared once, and
// where each surface offers it.
//
// A command is an act with a name: "New Session", "Stop", "Archive". The
// application declares the commands that apply now; it does not draw a
// toolbar or bind a key. The surface's idioms decide where a command is
// offered, and every command is reachable on every surface:
//
//   buttons   a command may ask for one of the pad's free buttons by intent
//             (`action`, `option`); the legend names what each button does
//             now. A command with no button is in the menu, which has one.
//   a bar     where contacts land, commands marked `bar` show as controls
//             in the pane's bar; the rest are in the menu its last control
//             opens.
//   keys      where there is a keyboard, a command's `key` chord runs it and
//             the menu shows the chord beside the title.
//
// One meaning per control: a button never means two things by how often or
// how long it is pressed, and a command does not move between buttons as
// state changes. A command that does not apply is disabled in place.
//
// Scopes order the commands: a scope pushed later (a sheet over a pane, the
// pane that has the focus) is asked first, and the first enabled command
// that wants a button gets it.

/** The pad's buttons an application may bind, by meaning (docs/HIG.md §1). */
export type ButtonIntent = "action" | "option" | "menu";

export interface Command {
  id: string;
  title: string;
  /** a short title for a bar's control and the legend; default the title */
  short?: string;
  /** the free button it takes while it applies */
  button?: ButtonIntent;
  /** a key chord as KeyboardEvent.key names it, modifiers first: "Control+n" */
  key?: string;
  /** shown as a control where the surface has a bar */
  bar?: boolean;
  /** the menu it is listed in where commands sit in a menu bar ("Session", "View"); commands that name none are in the application's own menu */
  menu?: string;
  /** undone only by doing the opposite: drawn in the warning colour, asked about first where the app says so */
  destructive?: boolean;
  /** not applicable now: shown disabled, takes no button */
  disabled?: boolean;
  /** a toggle's state */
  checked?: boolean;
  run(): void;
}

export interface CommandScope {
  id: string;
  commands: () => readonly Command[];
}

export interface Bound {
  /** every command that applies, innermost scope first, each id once */
  all: Command[];
  /** the command each free button runs */
  buttons: Partial<Record<ButtonIntent, Command>>;
  /** the command each key chord runs */
  keys: Map<string, Command>;
  /** the commands a bar shows as controls */
  bar: Command[];
  /** the commands the menu lists: all of them where there is no bar, the rest where there is one */
  menu: Command[];
}

export interface BindOptions {
  /** the surface has buttons to bind */
  buttons: boolean;
  /** the surface shows bar controls */
  bar: boolean;
  /** the surface has keys */
  keys: boolean;
  /** how many controls a bar holds beside the menu's (default 2) */
  barRoom?: number;
}

/** A chord with its modifiers in one order and its key in lower case, so "Ctrl+N" and "Control+n" are the same chord. */
export function normalizeChord(chord: string): string {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((part) => (part === "Ctrl" ? "Control" : part === "Cmd" || part === "Super" ? "Meta" : part === "Option" ? "Alt" : part)));
  const order = ["Control", "Alt", "Shift", "Meta"].filter((mod) => mods.has(mod));
  return [...order, key.length === 1 ? key.toLowerCase() : key].join("+");
}

/** The commands of `scopes` (outermost first) as one surface offers them. */
export function bindCommands(scopes: readonly CommandScope[], options: BindOptions): Bound {
  const all: Command[] = [];
  const seen = new Set<string>();
  for (let i = scopes.length - 1; i >= 0; i--) {
    for (const command of scopes[i]!.commands()) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      all.push(command);
    }
  }
  const buttons: Bound["buttons"] = {};
  const keys = new Map<string, Command>();
  const bar: Command[] = [];
  const room = options.barRoom ?? 2;
  for (const command of all) {
    if (options.buttons && command.button && !command.disabled && !buttons[command.button]) buttons[command.button] = command;
    if (options.keys && command.key && !command.disabled) {
      const chord = normalizeChord(command.key);
      if (!keys.has(chord)) keys.set(chord, command);
    }
    if (options.bar && command.bar && bar.length < room) bar.push(command);
  }
  const menu = all.filter((command) => !bar.includes(command));
  return { all, buttons, keys, bar, menu };
}

/** What the legend says: each bound button with its command's short title, in a fixed order. */
export function legendOf(bound: Bound, fixed: readonly { intent: string; label: string }[] = []): { intent: string; label: string }[] {
  const out: { intent: string; label: string }[] = [...fixed];
  for (const intent of ["action", "option", "menu"] as const) {
    const command = bound.buttons[intent];
    if (command) out.push({ intent, label: command.short ?? command.title });
  }
  return out;
}

/** Commands whose title matches a typed query, best first: every word of the query must appear; a match at a word's start ranks higher. */
export function searchCommands<T extends { title: string }>(items: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.slice();
  const scored: { item: T; score: number; at: number }[] = [];
  for (let i = 0; i < items.length; i++) {
    const title = items[i]!.title.toLowerCase();
    let score = 0;
    let ok = true;
    for (const word of words) {
      const at = title.indexOf(word);
      if (at < 0) {
        ok = false;
        break;
      }
      score += at === 0 ? 0 : title.charCodeAt(at - 1) === 0x20 ? 1 : 3;
      score += at / 64;
    }
    if (ok) scored.push({ item: items[i]!, score, at: i });
  }
  scored.sort((a, b) => a.score - b.score || a.at - b.at);
  return scored.map((entry) => entry.item);
}
