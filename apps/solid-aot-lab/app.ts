import { createContext, createMemo, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";

export interface Feature { id: string; label: string; enabled: boolean }
export interface LabTheme { enabledLabel: string }

export const ThemeContext = createContext<Accessor<LabTheme>>();
export const [theme, setTheme] = createSignal<LabTheme>({ enabledLabel: "ON" });
export const [count, setCount] = createSignal<i32>(0);
export const [features, setFeatures] = createSignal<Feature[]>([
  { id: "model", label: "MODEL", enabled: true },
  { id: "for", label: "KEYED FOR", enabled: true },
  { id: "slots", label: "SLOTS", enabled: true },
]);
export const enabledCount = createMemo<i32>(() => features().filter((f) => f.enabled).length);

let axisRemainder = 0;

export function adjustCount(delta: i32): void {
  axisRemainder += delta;
  const steps = Math.trunc(axisRemainder / 15_000);
  axisRemainder %= 15_000;
  setCount(Math.max(0, count() + steps));
}

export function resetCount(): void {
  setCount(0);
  axisRemainder = 0;
}

export function toggleFeature(id: string): void {
  setFeatures((list) => list.map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f)));
}
