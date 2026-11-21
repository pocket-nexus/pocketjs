import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [trigger,setTrigger]=createSignal(0);export const [a,setA]=createSignal(0);export const m=createMemo(()=>a());export const [result,setResult]=createSignal(0);createEffect(on([trigger],()=>{setA(1);const seen=m();setA(0);},{defer:true}));createEffect(on([m],()=>setResult(r=>r+1),{defer:true}));export function press(){setTrigger(1);}
