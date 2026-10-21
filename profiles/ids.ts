/** Names reserved by the profiles shipped with this framework distribution. */
export const BUILTIN_PROFILE_IDS: readonly string[] = [
  "psp", "psp-runtime", "3ds-runtime", "vita", "3ds-dev", "web-app", "macos-app", "linux-app", "macos-widget",
  "macos-embedded", "gba", "ipodnano",
];

/** CLI command words cannot identify a profile. */
export const PROFILE_COMMAND_WORDS: readonly string[] = [
  "build", "check", "compile", "create", "devtools", "help", "show", "tape", "target",
  "dev", "hw", "play", "psplink", "profile", "sdk", "catalog", "project", "status",
  "psp", "vita", "pack",
];
