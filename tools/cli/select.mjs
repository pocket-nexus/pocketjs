// tools/cli/select.mjs — which target a `pocket` verb acts on.
//
// The selection is the first of these that is present:
//
//   1. explicit   `pocket +<id> <verb>`, `pocket <verb> +<id>`, `--target <id>`
//                 or `--host-profile <file>`; two that differ are an error
//   2. env        POCKET_TARGET
//   3. override   the directory override of the nearest ancestor of the
//                 current directory (`pocket override set`)
//   4. project    the first entry of `targets` in the project's pocket.config.ts
//   5. default    the user default (`pocket default`)
//
// Overrides and the default live in <config>/pocket-nexus/settings.json, where
// <config> is XDG_CONFIG_HOME or ~/.config.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SETTINGS_SCHEMA = "pocket-settings/1";

export function settingsPath(env = process.env) {
  const configHome = env.XDG_CONFIG_HOME?.trim() ? resolve(env.XDG_CONFIG_HOME.trim()) : join(env.HOME || homedir(), ".config");
  return join(configHome, "pocket-nexus", "settings.json");
}

export function readSettings(env = process.env) {
  const path = settingsPath(env);
  if (!existsSync(path)) return { schema: SETTINGS_SCHEMA, overrides: {} };
  const settings = JSON.parse(readFileSync(path, "utf8"));
  if (settings.schema !== SETTINGS_SCHEMA) throw new Error(`${path}: unknown schema ${settings.schema}`);
  return { ...settings, overrides: settings.overrides ?? {} };
}

/** Writes by rename, so a concurrent reader sees the old or the new file. */
export function writeSettings(settings, env = process.env) {
  const path = settingsPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, JSON.stringify({ ...settings, schema: SETTINGS_SCHEMA }, null, 2) + "\n");
  renameSync(staging, path);
}

/** The override of `cwd` or of its nearest ancestor that has one. */
export function overrideFor(cwd, settings) {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const id = settings.overrides[directory];
    if (id) return { id, directory };
    if (dirname(directory) === directory) return null;
  }
}

/**
 * Takes the explicit selection out of a verb's arguments.
 * `leading` is a `+id` given before the verb. Returns `{ args, explicit }` or
 * `{ error }`; `explicit` is `{ id, origin }`, `{ hostProfile, origin }` or null.
 */
export function takeExplicitSelection(args, leading) {
  const rest = [...args];
  const separator = rest.indexOf("--");
  const before = separator >= 0 ? rest.slice(0, separator) : rest;
  const after = separator >= 0 ? rest.slice(separator) : [];
  const choices = [];
  if (leading) choices.push({ id: leading, origin: `+${leading}` });
  if (before[0]?.startsWith("+")) {
    const id = before.shift().slice(1);
    choices.push({ id, origin: `+${id}` });
  }
  const misplaced = before.find((value) => value.startsWith("+"));
  if (misplaced) return { error: `${misplaced} must come right after \`pocket\` or right after the command` };
  for (const flag of ["target", "host-profile"]) {
    const inline = before.findIndex((value) => value.startsWith(`--${flag}=`));
    if (inline >= 0) {
      const value = before.splice(inline, 1)[0].slice(flag.length + 3);
      choices.push(flag === "target" ? { id: value, origin: `--target ${value}` } : { hostProfile: value, origin: `--host-profile ${value}` });
      continue;
    }
    const index = before.indexOf(`--${flag}`);
    if (index < 0) continue;
    const value = before[index + 1];
    if (!value || value.startsWith("-")) return { error: `--${flag} requires a value` };
    before.splice(index, 2);
    choices.push(flag === "target" ? { id: value, origin: `--target ${value}` } : { hostProfile: value, origin: `--host-profile ${value}` });
  }
  const distinct = new Set(choices.map((choice) => choice.id ?? `host-profile:${choice.hostProfile}`));
  if (distinct.size > 1) return { error: `conflicting targets: ${choices.map((choice) => choice.origin).join(" and ")}` };
  return { args: [...before, ...after], explicit: choices[0] ?? null };
}

/**
 * Applies the order above. `project` is `{ config, targets: [{ id, … }] }` or
 * null. Returns `{ id, source, origin }` (plus `hostProfile` for an explicit
 * host profile) or null when no source names a target.
 */
export function select({ explicit, env = process.env, cwd = process.cwd(), settings, project }) {
  if (explicit) return { ...explicit, source: "explicit" };
  const fromEnv = env.POCKET_TARGET?.trim();
  if (fromEnv) return { id: fromEnv, source: "env", origin: "POCKET_TARGET" };
  const override = overrideFor(cwd, settings);
  if (override) return { id: override.id, source: "override", origin: `directory override ${override.directory}` };
  const first = project?.targets?.[0];
  if (first) return { id: first.id, source: "project", origin: project.config };
  if (settings.default) return { id: settings.default, source: "default", origin: "user default" };
  return null;
}

export const NO_SELECTION =
  "no target selected; name one with `pocket +<id> <command>` or `--target <id>`, set POCKET_TARGET, " +
  "set a directory override (`pocket override set <id>`), list `targets` in pocket.config.ts, " +
  "or set a user default (`pocket default <id>`)";
