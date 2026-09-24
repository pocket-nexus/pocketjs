import { createSignal, type Setter } from "solid-js";
import type { f32, i32, u8, u64 } from "@pocketjs/framework/solid/std";
import fixture from "./fixture.json";
export interface Nested { id: string }
export interface Item { id: string; label: string; children: Nested[] }
export const trace: string[] = [];
export const [rows, setRows] = createSignal<Item[]>(structuredClone(fixture.rows));
export const [open, writeOpen] = createSignal(true);
export const setOpen = ((value: boolean) => { trace.push("set:open:" + value); return writeOpen(value); }) as Setter<boolean>;
export const [late, setLate] = createSignal(false);
export const [live, setLive] = createSignal<i32>(0);
export const [angle, setAngle] = createSignal<i32>(0);
export const [removeNext, setRemoveNext] = createSignal(false);
export function load(): void { trace.push("parent mount"); setOpen(false); setLate(true); }
export function release(): void { trace.push("parent unmount"); }
export function replace(): void { trace.push("replace"); setRows(rows().map(row => ({ ...row, label: row.label + "+" }))); }
export function reverse(): void { trace.push("reverse"); setRows([...rows()].reverse()); }
export function rename(id: string): void { trace.push("rename:" + id); const row = rows().find(row => row.id === id); if (row) row.label += "!"; setRows([...rows()]); }
export function record(value: string): void { trace.push("record:" + value); }
export function event(value: string): void { trace.push("emit:saved:" + value); }
export function remove(): void { trace.push("remove:a"); setRows(rows().filter(row => row.id !== "a")); setRemoveNext(false); }
export function armRemoval(): void { trace.push("arm"); setRemoveNext(true); }
export function restore(): void { trace.push("restore:a"); setRows([...rows(), structuredClone(fixture.rows[0]!)]); }
export function adjust(delta: i32): void { trace.push("axis:" + delta); setAngle(angle() + delta); }
export function upright(degrees: f32, quality: u8, timestamp: u64): void { trace.push("upright:" + degrees + ":" + quality + ":" + timestamp); }
export function spin(x: f32, y: f32, z: f32): void { trace.push("spin:" + x + ":" + y + ":" + z); }
