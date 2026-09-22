import { createSignal, batch, untrack } from "solid-js";
import { createMemo, createEffect, on } from "@pocketjs/framework/solid/reactive";
import { copy, equals, len, frames, after, until, all, any, join, cancel, type i32, type Cap } from "@pocketjs/framework/solid/std";
const OUTER:i32=7; export const [result,setResult]=createSignal(0); function helper():i32{return OUTER;} export function press(){const OUTER=1;setResult(helper()+OUTER);}
