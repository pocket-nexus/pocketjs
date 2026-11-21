import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [result,setResult]=createSignal(0);export function press(){let n:i32=2;switch(n){case 1:setResult(1);break;case 2:setResult(7);break;default:setResult(9);break;}}
