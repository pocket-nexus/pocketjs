import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [count,setCount]=createSignal(1); export const [result,setResult]=createSignal(0); function helper(n:i32):i32{setCount(9);return n;} export function press(){setResult(helper(count()+1));}
