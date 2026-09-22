import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [count,setCount]=createSignal(0); export const [end,setEnd]=createSignal(0); export const [result,setResult]=createSignal(0);
createEffect(on([count],()=>setEnd(count()),{defer:true})); export function press(){setCount(1);setResult(end());}
