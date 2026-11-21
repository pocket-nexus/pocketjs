<script setup lang="ts">
import { Text, View } from "@pocketjs/framework/vue-vapor/components";
import { count } from "./Counter";
</script>

<template>
  <View class="w-full h-full flex-col gap-4 p-4 bg-slate-50">
    <Text class="text-lg text-slate-950">Count: {{ count }}</Text>
    <View class="p-2 rounded-lg bg-blue-600 focus:bg-blue-500"
          focusable @press="count++">
      <Text class="text-white">ADD ONE</Text>
    </View>
  </View>
</template>
