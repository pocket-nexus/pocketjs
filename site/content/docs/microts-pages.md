# Pages and focus

**A MicroTS application changes pages by writing a signal that a conditional
branch reads.** The AOT view subset has no router, page stack, dynamic
component or lazy import. Each page is a child component, the root model holds
the current page, and `Switch`/`Match` or `v-if` selects the mounted branch.

This page describes the branch forms, the lifetime of page state and the
position of focus after a switch. The guest build of an application with
`app.aot: true` uses the same branch and state rules as its native build.
Focus differs between the two builds in the cases
[listed below](#differences-in-the-guest-build).

| What you want to do | Where to start |
|---|---|
| Show one of several pages | [Select a page](#select-a-page) |
| Keep a page's state while another page is shown | [Page state across a switch](#page-state-across-a-switch) |
| Know which node receives the next press | [Focus after a switch](#focus-after-a-switch) |
| Compare the browser preview with the device | [Differences in the guest build](#differences-in-the-guest-build) |
| Fade a page out before the next one mounts | [Animate a switch](#animate-a-switch) |

## Select a page

The root model declares the page as a string-literal union and exports the
functions that change it:

```ts
// app.ts
import { createSignal } from "solid-js";

export type Page = "home" | "settings";

export const [page, setPage] = createSignal<Page>("home");

export function openSettings(): void {
  setPage("settings");
}

export function goHome(): void {
  setPage("home");
}
```

The root view mounts one `Match` branch. Pages report navigation through
callback props, and the root passes them to model functions:

```tsx
// app.tsx
import { Match, Switch } from "solid-js";
import { ActionHandler, View } from "@pocketjs/framework/solid/components";
import { BTN } from "@pocketjs/framework/input";
import HomePage from "./HomePage.tsx";
import SettingsPage from "./SettingsPage.tsx";
import { goHome, openSettings, page } from "./app";

export default function App() {
  return (
    <View class="w-full h-full flex-col p-4 bg-slate-50">
      <ActionHandler button={BTN.CROSS} active={page() === "settings"} onPress={goHome} />
      <Switch>
        <Match when={page() === "home"}>
          <HomePage onOpenSettings={() => openSettings()} />
        </Match>
        <Match when={page() === "settings"}>
          <SettingsPage onBack={() => goHome()} />
        </Match>
      </Switch>
    </View>
  );
}
```

```tsx
// HomePage.tsx
import { Text, View } from "@pocketjs/framework/solid/components";

export default function HomePage(props: { onOpenSettings: () => void }) {
  return (
    <View class="flex-col gap-2">
      <Text class="text-lg text-slate-950">Home</Text>
      <View class="p-2 bg-blue-600 focus:bg-blue-500" focusable
        onPress={() => props.onOpenSettings()}>
        <Text class="text-sm text-white">Open settings</Text>
      </View>
    </View>
  );
}
```

A Vue root uses `v-if` branches on the page components. Its model exports
`page` as `ref<Page>("home")`, and the pages declare their events with
`defineEmits`:

```vue
<!-- app.vue -->
<script setup lang="ts">
import { ActionHandler, View } from "@pocketjs/framework/vue-vapor/components";
import { BTN } from "@pocketjs/framework/vue-vapor/input";
import HomePage from "./HomePage.vue";
import SettingsPage from "./SettingsPage.vue";
import { goHome, openSettings, page } from "./app";
</script>

<template>
  <View class="w-full h-full flex-col p-4 bg-slate-50">
    <ActionHandler :button="BTN.CROSS" :active="page === 'settings'" @press="goHome()" />
    <HomePage v-if="page === 'home'" @open="openSettings()" />
    <SettingsPage v-else @back="goHome()" />
  </View>
</template>
```

**A child position takes JSX elements, not expressions that produce them.**
The Solid front end rejects `page() === "home" ? <HomePage /> : <SettingsPage />`
and `page() === "home" && <HomePage />` with
`Conditional children use <Show> or <Switch>`. Branch conditions are `boolean`:
compare the union with a literal. A third page adds a `Match` branch or a
`v-else-if`.

**Every page compiles into the application binary.** The guest components
`Screen`, `Portal`, `Modal`, `Lazy`, `Gallery`, `FocusScope` and `FocusGrid`
have no AOT form. Importing one into an AOT view fails with
`<Name> has no native runtime` in Solid and
`Host component <Name> is outside the AOT subset` in Vue. The
[Solid diagnostics table](/docs/microts-solid/#common-diagnostics) lists the
other rejected forms.

## Page state across a switch

**A branch swap unmounts the old page and mounts the new page in one view
update.** A page with a [model factory](/docs/microts-components/#give-each-child-its-own-state)
owns a region. Unmount cancels that region's tasks and drops its state; the
next mount runs the factory from its seeds.

| Where the state lives | After leaving and returning to the page |
|---|---|
| Signals or refs in the root model | Unchanged |
| A page factory's signals, memos and tasks | New instance; tasks from the previous mount are cancelled |
| Mount-time factory arguments | Read from the parent's values at the new mount |

State that outlives a page belongs to the root model and reaches the page
through props or context.

To keep a page mounted while another page is shown, wrap each page in a `View`
and switch its display. Solid selects between two complete class literals;
Vue uses `v-show` on the host element:

```tsx
<View class={page() === "home" ? "flex-col" : "hidden"}>
  <HomePage onOpenSettings={() => openSettings()} />
</View>
<View class={page() === "settings" ? "flex-col" : "hidden"}>
  <SettingsPage onBack={() => goHome()} />
</View>
```

```vue
<View v-show="page === 'home'" class="flex-col"><HomePage @open="openSettings()" /></View>
<View v-show="page === 'settings'" class="flex-col"><SettingsPage @back="goHome()" /></View>
```

Hiding a page does not unmount it: both pages keep their nodes, factory state
and tasks.

## Focus after a switch

**The AOT view and model subsets contain no call that moves focus.** The
guest framework's `FocusScope`, `FocusGrid` and `focusNode` are outside the
subset. The native runtime, `microts::Ui`, applies these rules:

- `DOWN` and `RIGHT` focus the next focusable node in document order; `UP` and
  `LEFT` focus the previous one. Movement stops at both ends.
- `CIRCLE` presses the focused node. A press whose target is hidden or not
  focusable is dropped.
- With no focused node, or with a hidden one, `DOWN` or `RIGHT` focuses the
  first visible focusable node and `UP` or `LEFT` focuses the last.

**After a branch swap that removed the focused node, no node is focused.**
Unmount destroys a page's nodes one at a time, children before their parent.
A destroyed node that holds focus passes it to the first focusable node of a
following sibling subtree, then of a preceding one, then to the nearest
focusable ancestor. When the page's last focusable node is destroyed, its
sibling subtrees hold none, and focus becomes empty unless an ancestor is
focusable. A focusable node beside the page branch does not receive it.

| Page structure | Focus after the switch | First `CIRCLE` |
|---|---|---|
| Branch swap, press came from a node of the old page | None | Dropped until a direction press |
| Hidden wrapper (`hidden` class or `v-show`) | Stays on the hidden node | Dropped until a direction press |
| Press came from a focusable node outside both pages | Stays on that node | Presses that node |

Three inputs act on the frame after a switch without a direction press:

- **An `ActionHandler` runs for its named button with or without focus.** Use
  one for back navigation, as the root view above does with `BTN.CROSS`.
  The handler on the removed page receives no `onRelease` for the press that
  switched pages. A handler on the new page that mounts while its button is
  still down reads that button as a press unless it is `latched`.
- **A focused node outside the page branch keeps focus across the swap.** A
  tab row or a toolbar placed beside the `Switch` stays focused while the
  pages under it change.
- **A touch host passes the pressed node in `Input.target`.** The press
  reaches that node's handler with no focused node.

A native host can assign focus with `Ui::set_focus(node)` between frames.
`Ui::initial_focus()` returns the focusable node with the lowest node id: the
earliest created one while no id has been reused. The core reuses the ids of
destroyed nodes, so after an unmount the result has no fixed relation to
document order.

### Differences in the guest build

The guest build runs the framework's focus manager in place of `microts::Ui`.
It repairs focus once per removed subtree, from that subtree's root, and it
delivers `CIRCLE` to the focused node without a visibility test. A browser
preview differs from the device in these cases:

| Case | Native build | Guest build |
|---|---|---|
| The focused node is inside the removed page and a focusable node follows the branch | No node is focused | The node after the branch receives focus |
| The focused node is inside a hidden wrapper | `CIRCLE` is dropped | `CIRCLE` runs the hidden node's handler |

A Rust host on the development machine reproduces the device's focus
position: call `frame` with `Input::buttons(...)` and read `Ui::focused()`.
See [Input & focus](/docs/input-focus/) for the guest focus manager.

## Animate a switch

**A branch swap has no exit phase.** The old page's nodes are destroyed in the
update that mounts the new page. To animate the change, an `async` model
function awaits an animation on a node that stays mounted and writes the page
signal after the await:

```ts
// app.ts
import { createSignal } from "solid-js";
import { animate, createNodeRef } from "@pocketjs/framework/animation";
import type { i32 } from "@pocketjs/framework/solid/std";

export type Page = "home" | "settings";

export const [page, setPage] = createSignal<Page>("home");
export const stage = createNodeRef();

async function show(next: Page): Promise<void> {
  await animate(stage, "opacity", 0, { dur: 100 as i32 });
  setPage(next);
  animate(stage, "opacity", 1, { dur: 100 as i32 });
}

export async function openSettings(): Promise<void> {
  await show("settings");
}
```

```tsx
<View class="flex-col" ref={stage}>
  <Switch>
    <Match when={page() === "home"}>
      <HomePage onOpenSettings={() => openSettings()} />
    </Match>
    <Match when={page() === "settings"}>
      <SettingsPage onBack={() => goHome()} />
    </Match>
  </Switch>
</View>
```

The task resumes at the frame boundary after the animation ends, so the old
page stays mounted for the fade. At 60 ticks per second the 100 ms fade above
holds the old page for six frames. A second call to `show` before the first
finishes cancels the first, as the
[task rules](/docs/microts-model/#tasks-and-host-services) describe. Style
changes on a mounted node can use the `transition-*` classes from
[Styling](/docs/styling/) without a task.
