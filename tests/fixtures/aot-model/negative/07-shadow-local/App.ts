import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
export const [result,setResult]=createSignal(0); function helper():i32{let x=9;return x;} export function press(){let x=3;helper();setResult(x);}
