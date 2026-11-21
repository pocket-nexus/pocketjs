import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [trigger,setTrigger]=createSignal(0);export const [mid,setMid]=createSignal(0);export const [result,setResult]=createSignal(0);createEffect(on([trigger],()=>setMid(1),{defer:true}));createEffect(on([mid],()=>setResult(mid()),{defer:true}));export function press(){setTrigger(1);}
