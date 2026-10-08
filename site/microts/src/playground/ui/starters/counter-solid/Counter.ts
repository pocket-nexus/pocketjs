import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";

export const [count, setCount] = createSignal<i32>(0);
