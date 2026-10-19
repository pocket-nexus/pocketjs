// apps/home/ui/alert.tsx — the iOS 6 alert view: a dimmed screen, a blue
// glass box with a white rim, an embossed title, a message and two buttons.
// While it is up it owns the touch screen and the A/B buttons.

import { createSignal, For, Show, type Accessor } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { FONT, wrap } from "./text.ts";
import type { Press, Target, TouchPage } from "./touch.ts";

export interface AlertSpec {
  title: string;
  message: string;
  /** The confirming button ("Delete"); Cancel is always offered. */
  action: string;
  run: () => void;
}

const W = 252;
const X = (320 - W) / 2;

export interface Alerts {
  current: Accessor<AlertSpec | null>;
  show(alert: AlertSpec): void;
  touch(): TouchPage | null;
  key(pressed: number): boolean;
  view: () => ReturnType<typeof View>;
}

export function createAlerts(press: Press): Alerts {
  const [current, setCurrent] = createSignal<AlertSpec | null>(null);
  const [choice, setChoice] = createSignal(0);
  const lines = () => {
    const alert = current();
    return alert ? wrap(alert.message, FONT.xs, W - 24, 4) : [];
  };
  const titleLines = () => {
    const alert = current();
    return alert ? wrap(alert.title, FONT.smBold, W - 24, 2) : [];
  };
  const height = () => 18 + titleLines().length * 18 + lines().length * 15 + 12 + 30 + 12;
  const top = () => Math.round((240 - height()) / 2);
  const buttonY = () => top() + height() - 42;
  const close = () => setCurrent(null);
  const confirm = () => {
    const alert = current();
    close();
    alert?.run();
  };

  return {
    current,
    show(alert) {
      setChoice(0);
      setCurrent(alert);
    },
    touch() {
      if (!current()) return null;
      const targets: Target[] = [
        { id: "alert.cancel", x: X + 10, y: buttonY(), w: W / 2 - 15, h: 30, run: close },
        { id: "alert.action", x: X + W / 2 + 5, y: buttonY(), w: W / 2 - 15, h: 30, run: confirm },
      ];
      return { targets: () => targets };
    },
    key(pressed) {
      if (!current()) return false;
      if (pressed & (BTN.LEFT | BTN.RIGHT)) setChoice(choice() ? 0 : 1);
      else if (pressed & BTN.CIRCLE) {
        press.down(choice() ? "alert.action" : "alert.cancel");
        press.release();
        if (choice()) confirm();
        else close();
      } else if (pressed & BTN.CROSS) close();
      return true;
    },
    view: () => (
      <Show when={current()}>
        {(alert) => (
          <View class="absolute left-0 top-0 w-[320] h-[240] bg-[#00000080]">
            <View
              class="absolute rounded-[10] border-[#e8edf5] border-2 bg-gradient-to-b from-[#3a4f7ef0] via-[#1f3466f0] to-[#14254ff0] shadow-lg"
              style={{ insetL: X, insetT: top(), width: W, height: height() }}
            />
            <View class="absolute rounded-[9] bg-gradient-to-b from-[#ffffff50] to-[#ffffff10]" style={{ insetL: X + 2, insetT: top() + 2, width: W - 4, height: 26 }} />
            <For each={titleLines()}>
              {(line, index) => (
                <>
                  <Text class="absolute text-sm text-[#00000080] font-bold text-center" style={{ insetL: X, insetT: top() + 13 + index() * 18, width: W }}>{line}</Text>
                  <Text class="absolute text-sm text-white font-bold text-center" style={{ insetL: X, insetT: top() + 14 + index() * 18, width: W }}>{line}</Text>
                </>
              )}
            </For>
            <For each={lines()}>
              {(line, index) => (
                <Text class="absolute text-xs text-white text-center" style={{ insetL: X, insetT: top() + 18 + titleLines().length * 18 + index() * 15, width: W }}>{line}</Text>
              )}
            </For>
            <View
              class={press.is("alert.cancel") || choice() === 0
                ? "absolute h-[30] rounded-[6] border border-[#0d1630] bg-gradient-to-b from-[#7d8bab] via-[#4f5e82] to-[#3a4a70]"
                : "absolute h-[30] rounded-[6] border border-[#0d1630] bg-gradient-to-b from-[#5b6b90] via-[#334470] to-[#24345e]"}
              style={{ insetL: X + 10, insetT: buttonY(), width: W / 2 - 15 }}
            />
            <Text class="absolute text-sm text-white font-bold text-center" style={{ insetL: X + 10, insetT: buttonY() + 7, width: W / 2 - 15 }}>Cancel</Text>
            <View
              class={press.is("alert.action") || choice() === 1
                ? "absolute h-[30] rounded-[6] border border-[#0d1630] bg-gradient-to-b from-[#a3b1d0] via-[#7486ad] to-[#5c6f9a]"
                : "absolute h-[30] rounded-[6] border border-[#0d1630] bg-gradient-to-b from-[#8696ba] via-[#5a6c96] to-[#475a86]"}
              style={{ insetL: X + W / 2 + 5, insetT: buttonY(), width: W / 2 - 15 }}
            />
            <Text class="absolute text-sm text-white font-bold text-center" style={{ insetL: X + W / 2 + 5, insetT: buttonY() + 7, width: W / 2 - 15 }}>{alert().action}</Text>
          </View>
        )}
      </Show>
    ) as unknown as ReturnType<typeof View>,
  };
}
