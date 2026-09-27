// apps/pocket-chan/app.tsx — Pocket Chan's character sheet on a 480x272 PSP.
//
// Nine baked clips (tools/pocket-chan/bake.py) sit in the pak as sprite
// atlases; <Sprite> binds one and the core advances its cells off the vblank
// counter, so switching pose is one prop write and no JavaScript per frame.
// The d-pad walks the sheet, CIRCLE turns the page on what she is saying and
// TRIANGLE swaps the language of every string on screen.
//
// Font slots are rationed on purpose: the CJK fallback face bakes every
// collected codepoint into EVERY slot the styles use, so this screen spends
// four — text-xs, text-xs bold, text-sm, text-lg bold — and no more.

import { createSignal } from "solid-js";
import { Sprite, Text, View } from "@pocketjs/framework/solid/components";
import { onButtonPress } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { LANG_NAME, PALETTE, POSES, SET_NAME, UI, type Lang, type Say } from "./chan.ts";

const SETS = 3;

function say(value: Say, lang: Lang): string {
  return value[lang];
}

/** Indices of the poses in one set, in sheet order. */
function setPoses(set: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < POSES.length; i += 1) if (POSES[i].set === set) out.push(i);
  return out;
}

const BY_SET = [setPoses(0), setPoses(1), setPoses(2)];

export default function PocketChan() {
  const [set, setSet] = createSignal(0);
  const [slot, setSlot] = createSignal(0);
  const [line, setLine] = createSignal(0);
  const [lang, setLang] = createSignal<Lang>(0);
  const [sheet, setSheet] = createSignal(false);

  const members = () => BY_SET[set()];
  const pose = () => POSES[members()[slot()] ?? 0];

  const step = (delta: number) => {
    const n = members().length;
    setSlot((slot() + delta + n) % n);
    setLine(0);
  };
  const stepSet = (delta: number) => {
    setSet((set() + delta + SETS) % SETS);
    setSlot(0);
    setLine(0);
  };

  onButtonPress(BTN.LEFT, () => step(-1));
  onButtonPress(BTN.RIGHT, () => step(1));
  onButtonPress(BTN.UP | BTN.LTRIGGER, () => stepSet(-1));
  onButtonPress(BTN.DOWN | BTN.RTRIGGER, () => stepSet(1));
  onButtonPress(BTN.CIRCLE, () => setLine((line() + 1) % pose().lines.length));
  onButtonPress(BTN.TRIANGLE, () => setLang(((lang() + 1) % 3) as Lang));
  onButtonPress(BTN.SQUARE, () => setSheet(!sheet()));
  onButtonPress(BTN.CROSS, () => setSheet(false));

  return (
    <View debugName="ChanScreen" class="relative w-full h-full flex-col bg-gradient-to-b from-[#1C1630] to-[#0E0B1A] overflow-hidden">
      <View debugName="TopBar" class="flex-row items-end justify-between px-4 pt-2">
        <View class="flex-row items-end gap-2">
          <Text class="text-lg text-[#FFD400] font-bold tracking-wide">POCKET CHAN</Text>
          <Text class="text-xs text-[#8E80AC]">{say(UI.subtitle, lang())}</Text>
        </View>
        <View class="flex-row items-center gap-2">
          <View class="px-2 py-1 rounded-md bg-[#2B2148] border-[#413363]">
            <Text class="text-xs text-[#CBBDE2] font-bold">{say(LANG_NAME, lang())}</Text>
          </View>
          <View class="px-2 py-1 rounded-md bg-[#35C8E8]">
            <Text class="text-xs text-[#0E0B1A] font-bold">{say(SET_NAME[set()], lang())}</Text>
          </View>
        </View>
      </View>

      <View debugName="Body" class="flex-row grow items-center px-4 gap-3">
        <View debugName="Stage" class="relative w-[146] h-[180] rounded-xl bg-[#231B3B] border-[#3A2E5C]">
          <View class="absolute left-[40] top-[134] w-[66] h-[7] rounded-full bg-[#150F26]" />
          <View class="absolute left-[9] top-[16] w-[128] h-[128]">
            <Sprite class="w-[128] h-[128]" sprite={pose().sprite} />
          </View>
        </View>

        <View debugName="Card" class="flex-col grow h-[180] justify-center gap-2">
          <Text class="text-lg text-[#FCF6FF] font-bold">{say(pose().name, lang())}</Text>
          <View class="flex-row items-center gap-2">
            <View class="w-[26] h-[3] rounded-full bg-[#FF3D8B]" />
            <Text class="text-xs text-[#8E80AC] tracking-wide">{pose().key.toUpperCase()}</Text>
          </View>
          <View class="h-[44] flex-col justify-start">
            <Text class="text-sm text-[#CBBDE2]">{pose().lines[line()][lang()]}</Text>
          </View>
          <View debugName="Dots" class="flex-row items-center gap-2">
            {BY_SET[0].map((_, i) => (
              <View class={set() === 0 && slot() === i
                ? "w-[14] h-[4] rounded-full bg-[#FFD400]"
                : "w-[4] h-[4] rounded-full bg-[#413363]"} />
            ))}
            <View class="w-2 h-[4]" />
            {BY_SET[1].map((_, i) => (
              <View class={set() === 1 && slot() === i
                ? "w-[14] h-[4] rounded-full bg-[#FFD400]"
                : "w-[4] h-[4] rounded-full bg-[#413363]"} />
            ))}
            <View class="w-2 h-[4]" />
            {BY_SET[2].map((_, i) => (
              <View class={set() === 2 && slot() === i
                ? "w-[14] h-[4] rounded-full bg-[#FFD400]"
                : "w-[4] h-[4] rounded-full bg-[#413363]"} />
            ))}
          </View>
        </View>
      </View>

      <View debugName="Hints" class="flex-row items-center justify-between px-4 py-2">
        <View class="flex-row items-center gap-3">
          <Hint cap="L R" label={say(UI.set, lang())} />
          <Hint cap="< >" label={say(UI.pose, lang())} />
          <Hint cap="O" label={say(UI.talk, lang())} />
          <Hint cap="^" label={say(UI.lang, lang())} />
          <Hint cap="[]" label={say(UI.sheet, lang())} />
        </View>
        <Text class="text-xs text-[#5C4F7A]">{`${slot() + 1}/${members().length}`}</Text>
      </View>

      <View
        debugName="SheetOverlay"
        class={sheet()
          ? "absolute top-0 left-0 w-full h-full flex-col px-5 py-4 gap-3 bg-[#120D22]"
          : "absolute top-0 left-0 w-0 h-0 overflow-hidden"}
      >
        <Text class="text-lg text-[#FFD400] font-bold tracking-wide">{say(UI.palette, lang())}</Text>
        <View class="flex-row flex-wrap gap-2">
          {PALETTE.map((s) => (
            <View class="flex-row items-center gap-2 w-[138] px-2 py-1 rounded-lg bg-[#1E1733] border-[#332856]">
              <View class={s.dot} />
              <View class="flex-col">
                <Text class="text-xs text-[#FCF6FF] font-bold">{`#${s.hex}`}</Text>
                <Text class="text-xs text-[#8E80AC]">{say(s.name, lang())}</Text>
              </View>
            </View>
          ))}
        </View>
        <Text class="text-xs text-[#8E80AC] tracking-wide">{say(UI.build, lang())}</Text>
        <Text class="text-sm text-[#CBBDE2]">
          9 x 512x256 RGBA4444, 8 frames of 128x128, one pak
        </Text>
        <View class="flex-row items-center gap-2">
          <Hint cap="[]" label={say(UI.close, lang())} />
          <Hint cap="X" label={say(UI.close, lang())} />
        </View>
      </View>
    </View>
  );
}

function Hint(props: { cap: string; label: string }) {
  return (
    <View class="flex-row items-center gap-1">
      <View class="px-1 py-1 rounded-md bg-[#2B2148] border-[#413363]">
        <Text class="text-xs text-[#FFD400] font-bold">{props.cap}</Text>
      </View>
      <Text class="text-xs text-[#8E80AC]">{props.label}</Text>
    </View>
  );
}
