import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [trigger,setTrigger]=createSignal(0);export const [count,setCount]=createSignal(0);export const double=createMemo(()=>count()*2);export const [x,setX]=createSignal(0);export const [result,setResult]=createSignal(0);createEffect(on([trigger],()=>{setCount(1);setX(double());setCount(2);setResult(double());},{defer:true}));export function press(){setTrigger(1);}
