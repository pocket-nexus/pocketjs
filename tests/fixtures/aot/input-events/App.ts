import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";
export const trace: string[] = [];
export const [delay, setDelay] = createSignal<i32>(90);
export const [live, setLive] = createSignal(true);
export const [open, setOpen] = createSignal(false);
export const [held, setHeld] = createSignal<i32>(0);
export function press(pressed: i32, buttons: i32): void { trace.push("press:" + pressed + ":" + buttons); setHeld(held() + 1); }
export function hold(mask: i32, buttons: i32): void { trace.push("hold:" + mask + ":" + buttons); }
export function release(released: i32, buttons: i32): void { trace.push("release:" + released + ":" + buttons); setHeld(held() - 1); }
export function combo(pressed: i32, buttons: i32): void { trace.push("combo:" + pressed + ":" + buttons); }
export function record(value: string): void { trace.push(value); }
export function toggleLive(): void { trace.push("live:" + !live()); setLive(!live()); }
export function toggleOpen(): void { trace.push("open:" + !open()); setOpen(!open()); }
