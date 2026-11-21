import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [armed,setArmed]=createSignal(false);
export const [tick,setTick]=createSignal(0);
createEffect(()=>{if(armed())console.log(tick());});
