/** Installed native apps keep their process and guest when switching. */
export interface SymbianNavigationApp {
  uid: string;
  id: string;
  output: string;
  title: string;
  orientation?: "auto" | "portrait";
}

export function encodeSymbianNavigation(value: unknown, currentUid: string): string {
  const config = value as { shell?: unknown; apps?: unknown } | null;
  if (!config || typeof config.shell !== "string" || !Array.isArray(config.apps) ||
      config.apps.length < 2 || config.apps.length > 32) {
    throw new Error("Native navigation requires a shell UID and 2..32 apps");
  }
  const apps = config.apps as SymbianNavigationApp[];
  const uids = new Set<string>(), ids = new Set<string>(), outputs = new Set<string>();
  for (const app of apps) {
    if (!app || typeof app.uid !== "string" || typeof app.id !== "string" || typeof app.output !== "string" || (app.orientation !== undefined && app.orientation !== "auto" && app.orientation !== "portrait") || !/^0xE[0-9A-F]{7}$/.test(app.uid) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(app.id) ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(app.output) ||
        typeof app.title !== "string" || !app.title.trim() || app.title.length > 128 || /[\x00-\x1f]/.test(app.title) ||
        uids.has(app.uid) || ids.has(app.id) || outputs.has(app.output)) {
      throw new Error("Invalid or duplicate native navigation app");
    }
    uids.add(app.uid); ids.add(app.id); outputs.add(app.output);
  }
  if (!uids.has(config.shell) || !uids.has(currentUid)) {
    throw new Error("Native navigation must contain this package and its shell");
  }
  return [apps.find(app => app.uid === config.shell)!, ...apps.filter(app => app.uid !== config.shell)]
    .map(app => [app.uid, app.output, app.id, app.title, app.orientation ?? "auto"].join("\t")).join("\n") + "\n";
}
