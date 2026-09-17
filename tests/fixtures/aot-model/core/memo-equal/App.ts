import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [count,setCount]=createSignal(1); export const positive=createMemo(()=>count()>0); export const [result,setResult]=createSignal(0);createEffect(on([positive],()=>setResult(r=>r+1),{defer:true}));export function press(){setCount(2);}
