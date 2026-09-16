/** One reconciliation at a time. USB disappearance and child exits are expected
 * states; each pass restores the selected device's pairing and transport. */
export function superviseCompanion(options: {
  reconcile(): Promise<void>;
  stopped(): boolean;
  wait(): Promise<void>;
  status(message: string): void;
}) {
  return (async () => {
    let previous = "";
    while (!options.stopped()) {
      let status = "USB companion ready";
      try { await options.reconcile(); }
      catch (error) { status = `Waiting for USB companion: ${error instanceof Error ? error.message : "unavailable"}`; }
      if (status !== previous) { options.status(status); previous = status; }
      if (!options.stopped()) await options.wait();
    }
  })();
}

/** Bun leaves exitCode null after signal termination; both fields matter. */
export function childRunning(child: { exitCode: number | null; signalCode: string | null } | undefined): boolean {
  return !!child && child.exitCode === null && child.signalCode === null;
}
