## Counter.tsx

```tsx
import { Text, View } from "@pocketjs/framework/solid/components";
import { count, setCount } from "./Counter";

export default function Counter() {
  return (
    <View class="w-full h-full flex-col gap-4 p-4 bg-slate-50">
      <Text class="text-lg text-slate-950">Count: {count()}</Text>
      <View class="p-2 rounded-lg bg-blue-600 focus:bg-blue-500" focusable
        onPress={() => setCount(count() + 1)}>
        <Text class="text-white">ADD ONE</Text>
      </View>
    </View>
  );
}
```

## Counter.ts

```ts
import { createSignal } from "solid-js";
import type { i32 } from "@pocketjs/framework/solid/std";

export const [count, setCount] = createSignal<i32>(0);
```

## gen/counter.rs

```rust
// The view-model trait MicroTS generates from Counter.tsx + Counter.ts
pub trait CounterViewModel {
    fn count(&self) -> i32;
    fn set_count(&mut self, value: i32);
}

// {count()}       reads vm.count(), formats the text when it changes,
//                 and sends the new text through ui.set_text(...)
// onPress={...}   on a matching press runs setCount(count() + 1) as
//                 vm.set_count(vm.count().wrapping_add(1i32))
```
