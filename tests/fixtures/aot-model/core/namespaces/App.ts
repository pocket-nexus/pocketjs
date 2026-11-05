import { createSignal } from "solid-js";
import { push, type i32 } from "@pocketjs/framework/solid/std";
import { counter, util } from "./lib/index";
import * as direct from "./lib/util";
export const [result, setResult] = createSignal<i32[]>([]);
export function press(): void {
  counter.add(3);
  counter.add(util.double(4));
  counter.total += 1;
  const out: i32[] = [];
  push(out, counter.total);
  push(out, counter.limits.MAX);
  push(out, counter.limits.clampTo(15));
  push(out, direct.double(5));
  setResult(out);
}
