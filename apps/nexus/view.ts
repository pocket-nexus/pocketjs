// apps/nexus/view.ts — view helpers shared by the Pocket Nexus scenes.

import { onMount } from "solid-js";

/** Style object for an absolutely placed box. */
export function box(x: number, y: number, w: number, h: number, extra: Record<string, number> = {}) {
  return { posType: 1, insetL: x, insetT: y, width: w, height: h, ...extra };
}

/** Runs `run` once the nodes before it exist; placed last, after every ref is set. */
export function AfterMount(props: { run: () => void }) {
  onMount(() => props.run());
  return null;
}
