<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";

const props = withDefaults(defineProps<{ label?: string }>(), {
  label: "VALUE +1",
});
const model = defineModel<i32>({ required: true });
</script>

<template>
  <View
    debug-name="ModelButton"
    class="flex-row items-center justify-between px-3 py-2 rounded-lg shadow bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"
    focusable
    @press="model++"
  >
    <Text class="text-sm text-white font-bold">{{ props.label }}</Text>
    <Text class="text-sm text-white font-bold">{{ model }}</Text>
  </View>
</template>
