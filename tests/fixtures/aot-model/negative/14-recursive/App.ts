import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [result,setResult]=createSignal(0); function fact(n:i32):i32{if(n===0)return 1;return n*fact(n-1);} export function press(){setResult(fact(5));}
