import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [count,setCount]=createSignal(0);export const m1=createMemo(()=>count()+1);export const m2=createMemo(()=>m1()*2);export const [result,setResult]=createSignal(0);export function press(){setCount(4);setResult(m2());}
