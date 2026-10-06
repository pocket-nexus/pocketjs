// The globals a Pocket app may use that no TypeScript library file declares.
// checkProjectTypes (app-check.ts) adds this file to a project it checks with
// `lib: ["ES2022"]` and no `types`: there is no DOM and no Node on a device.

interface PocketConsole {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
  debug(...values: unknown[]): void;
}

declare var console: PocketConsole;
