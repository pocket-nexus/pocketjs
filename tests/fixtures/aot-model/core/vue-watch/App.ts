import { ref, computed } from "vue";
import { watch } from "@pocketjs/framework/vue-vapor/reactive";
export const count = ref(0);
export const doubled = computed(() => count.value * 2);
export const result = ref(0);
watch(count, () => { result.value = doubled.value; });
export function press(): void { count.value += 1; }
