import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [count,setCount]=createSignal(3);export const [result,setResult]=createSignal(0);export function press(){for(let i=0;i<count();i++){setCount(0);setResult(n=>n+1);}}
