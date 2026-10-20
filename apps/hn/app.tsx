// apps/hn/app.tsx — Hacker News for Pocket on the 3DS.
//
// The whole app is on the touch screen: stories under a Top/New/Best/Ask/
// Show segmented control, then a story's thread with the story and every
// comment in full. The top screen belongs to the system (capability
// "system.agent"). L and R change the feed on the story list and page
// through a thread.
//
// Every request rides @pocketjs/framework/net, which on the 3DS goes through
// the linked Mac, two at a time.

import { createSignal } from "solid-js";
import { AuxiliarySurface, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { companionNow } from "@pocketjs/framework/link";
import { createNavStack } from "../home/ui/nav.tsx";
import { createPress, createTouchRouter } from "../home/ui/touch.ts";
import { createHnModel } from "./model.ts";
import { commentsPage, listPage, type HnEnv } from "./views.tsx";

const ALL_BUTTONS = 0xffff;

export default function HackerNews() {
  const model = createHnModel();
  const press = createPress();
  const [keys, setKeys] = createSignal(false);
  // Ages need minutes, not frames: the clock signal changes once a minute.
  const [now, setNow] = createSignal(Math.floor(companionNow() / 60000) * 60000);
  let frames = 0;
  onFrame(() => {
    if (++frames % 60 === 0) setNow(Math.floor(companionNow() / 60000) * 60000);
  });

  const env: HnEnv = { model, press, keys, now };

  const stack = createNavStack({
    press,
    keys,
    setKeys,
    onExit: () => undefined,
    rootBack: null,
    page(id, nav, layer) {
      return id === "comments" ? commentsPage(env, nav, layer) : listPage(env, nav, layer);
    },
  });
  stack.reset("list");
  model.setFeed("top");

  createTouchRouter({
    surface: "auxiliary",
    press,
    page: () => stack.touch(),
    active: () => !stack.busy(),
    onTouch: () => setKeys(false),
  });

  onButtonPress(ALL_BUTTONS, (pressed) => {
    stack.key(pressed);
  });

  return (
    <AuxiliarySurface>
      <View class="relative w-full h-full bg-white overflow-hidden">{stack.view()}</View>
    </AuxiliarySurface>
  );
}
