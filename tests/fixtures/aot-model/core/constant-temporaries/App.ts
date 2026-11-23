import { createSignal } from "solid-js";
import { createMemo } from "@pocketjs/framework/solid/reactive";
import { f32 } from "@pocketjs/framework/solid/std";
// Each initializer binds its f32() operands as temporaries; every read of the constant declares its own.
const K = f32(0.5) * f32(2);
const A = f32(0.5);
const J = A * f32(2);
export const [value, setValue] = createSignal<f32>(K + J);
export const [result, setResult] = createSignal<f32>(f32(0));
export const twice = createMemo(() => value() * J + J);
function scaled(x: f32, by: f32 = K * K): f32 {
  return x * by;
}
export function step(): void {
  setValue(value() * K + K);
}
export function scale(): void {
  setResult(scaled(J) + scaled(J) + scaled(J, J + J));
}
