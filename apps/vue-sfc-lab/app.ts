import { computed, ref } from "vue";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";

export interface Feature {
  id: string;
  label: string;
  enabled: boolean;
}

export const count = ref<i32>(0);
export const features = ref<Feature[]>([
  { id: "model", label: "MODEL", enabled: true },
  { id: "for", label: "V-FOR", enabled: true },
  { id: "slots", label: "SLOTS", enabled: true },
]);
export const enabledCount = computed<i32>(() => features.value.filter((feature) => feature.enabled).length);

let axisRemainder = 0;

export function adjustCount(delta: i32): void {
  axisRemainder += delta;
  const steps = Math.trunc(axisRemainder / 15_000);
  axisRemainder %= 15_000;
  count.value = Math.max(0, count.value + steps);
}

export function resetCount(): void {
  count.value = 0;
  axisRemainder = 0;
}

export function toggleFeature(id: string): void {
  const feature = features.value.find((candidate) => candidate.id === id);
  if (feature) feature.enabled = !feature.enabled;
}
