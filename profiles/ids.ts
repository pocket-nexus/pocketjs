/** Names reserved by the profiles shipped with this framework distribution. */
export const BUILTIN_PROFILE_IDS: readonly string[] = [
  "psp", "vita", "3ds-dev", "pocketbook", "web-app", "macos-app", "linux-app", "macos-widget",
  "moto-g-play-dev", "redmi-1s-dev", "blackberry-qnx-dev", "meizu-m8-dev", "symbian-e7-dev",
  "ios-dev", "iphone2g-dev", "iphone4s-dev", "ipodtouch-dev", "ipodtouch4-dev",
  "macos-embedded", "gba", "ipodnano",
];

/** CLI command words cannot identify a profile. */
export const PROFILE_COMMAND_WORDS: readonly string[] = [
  "build", "check", "compile", "create", "devtools", "help", "show", "tape", "target",
  "dev", "hw", "play", "psplink", "profile", "sdk", "catalog", "project", "status",
  "psp", "vita", "symbian", "ios", "pack",
];
