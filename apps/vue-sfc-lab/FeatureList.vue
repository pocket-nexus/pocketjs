<script setup lang="ts" generic="T extends { id: string }">
import { View } from "@pocketjs/framework/vue-vapor/components";

const props = defineProps<{ items: T[] }>();
defineSlots<{ row(props: { item: T }): any }>();
</script>

<template>
  <View class="flex-row gap-2">
    <template v-for="item in props.items" :key="item.id">
      <slot name="row" :item="item" />
    </template>
  </View>
</template>
