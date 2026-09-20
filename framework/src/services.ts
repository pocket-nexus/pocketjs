// Framework-neutral per-tick service pumps. UI lifecycle hooks are component
// scoped and differ between Solid, Vue Vapor and Octane; module Promise
// delivery is realm scoped and must not depend on any of them.
//
// Modules with pending work register here. Transport receive pumps run before
// that work, and submit pumps send requests it creates in the same frame.

type ServicePump = () => void;
type ServicePhase = "receive" | "work" | "submit";

const pumps = {
  receive: new Set<ServicePump>(),
  work: new Set<ServicePump>(),
  submit: new Set<ServicePump>(),
};

export function registerServicePump(pump: ServicePump, phase: ServicePhase = "work"): () => void {
  pumps[phase].add(pump);
  return () => pumps[phase].delete(pump);
}

export function runServicePumps(): void {
  // A pump may remove itself while running; Set iteration safely advances to
  // the next entry without a snapshot allocation on this per-frame path.
  for (const pump of pumps.receive) pump();
  for (const pump of pumps.work) pump();
  for (const pump of pumps.submit) pump();
}
