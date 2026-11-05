import { createSignal } from "solid-js";
import { push, type i32 } from "@pocketjs/framework/solid/std";
import { hit, hits, score, logged } from "./state";
export const [result, setResult] = createSignal<i32[]>([]);
export function press(): void {
  hit(1); hit(3); hit(1); hit(9);
  hits[0] = 5;
  const out: i32[] = [];
  for (const h of hits) push(out, h);
  push(out, score);
  push(out, logged());
  setResult(out);
}
