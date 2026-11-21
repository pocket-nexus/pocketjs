## Counter.vue

```vue
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
```

## Counter.ts

```ts
import { ref } from "vue";
import type { i32 } from "@pocketjs/framework/vue-vapor/std";

export const count = ref<i32>(0);
```

## gen/counter.rs

```rust
// The view-model trait MicroTS generates from Counter.vue + Counter.ts
pub trait CounterViewModel {
    fn count(&self) -> i32;
    fn set_count(&mut self, value: i32);
}

// {{ count }}     reads vm.count(), formats the text when it changes,
//                 and sends the new text through ui.set_text(...)
// @press=count++  on a matching press calls
//                 vm.set_count(vm.count().wrapping_add(1i32))
```
