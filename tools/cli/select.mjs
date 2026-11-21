// Profile selection: CLI, POCKET_TARGET, then the nearest host config.
export function takeExplicitSelection(args, leading) {
  const separator = args.indexOf("--");
  const before = separator >= 0 ? args.slice(0, separator) : [...args];
  const after = separator >= 0 ? args.slice(separator) : [];
  const choices = [];
  if (leading) choices.push({ id: leading, origin: `+${leading}` });
  if (before[0]?.startsWith("+")) {
    const id = before.shift().slice(1);
    if (!id) return { error: "+ requires a profile" };
    choices.push({ id, origin: `+${id}` });
  }
  const misplaced = before.find(value => value.startsWith("+"));
  if (misplaced) return { error: `${misplaced} must come right after \`pocket\` or right after the command` };
  for (let index = 0; index < before.length;) {
    const argument = before[index];
    if (argument === "--target" || argument.startsWith("--target=")) {
      const inline = argument.startsWith("--target=");
      const id = inline ? argument.slice(9) : before[index + 1];
      if (!id || id.startsWith("--")) return { error: "--target requires a value" };
      before.splice(index, inline ? 1 : 2);
      choices.push({ id, origin: `--target ${id}` });
    } else index++;
  }
  if (new Set(choices.map(choice => choice.id)).size > 1) return { error: `conflicting targets: ${choices.map(choice => choice.origin).join(" and ")}` };
  return { args: [...before, ...after], explicit: choices[0] ?? null };
}

export function select({ explicit, env = process.env, project }) {
  if (explicit) return { ...explicit, source: "explicit" };
  if (env.POCKET_TARGET?.trim()) return { id: env.POCKET_TARGET.trim(), source: "env", origin: "POCKET_TARGET" };
  if (project?.profiles?.length === 1) return { id: project.profiles[0].id, source: "project", origin: project.config };
  return null;
}
export const NO_SELECTION = "no host selected; use --target, POCKET_TARGET, or a single-host pocket.host.config.ts";
