import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { View } from "@pocketjs/framework/components";
import { RANK_LETTERS, type GameResult } from "../game/result.ts";
import type { TextTone } from "../ui/text-classes.ts";
import { Button, Chip, Label, LeftLabel } from "../ui/kit.tsx";

function rankTone(rank: number): TextTone {
  if (rank >= 4) return "amber";
  if (rank === 3) return "sky";
  if (rank === 0) return "coral";
  return "mist";
}

function Row(props: { y: number; name: string; value: () => string; tone: TextTone }): JSX.Element {
  return (
    <>
      <LeftLabel x={150} y={props.y} w={110} h={16} text={props.name} size="xs" tone="mist" />
      <Label x={290} y={props.y} w={90} h={16} text={props.value} size="xsb" tone={props.tone} />
    </>
  );
}

export interface ResultProps {
  result: () => GameResult | undefined;
  onRetry: () => void;
  onSongs: () => void;
}

export function Result(props: ResultProps): JSX.Element {
  const r = () => props.result();
  return (
    <View
      debugName="Result"
      class="absolute left-0 top-[720] w-[400] h-[240] bg-gradient-to-b from-[#0b1622] to-[#12304a] overflow-hidden"
    >
      <Label x={0} y={10} w={400} h={24} text={() => (r()?.failed ? "STAGE FAILED" : "STAGE CLEAR")} size="lg" tone={r()?.failed ? "coral" : "white"} />
      <Label x={0} y={34} w={400} h={14} text={() => r()?.title ?? ""} size="xs" tone="mist" />

      <View
        class="absolute bg-[#12304a] border-4 border-[#ffc857]"
        style={{ insetL: 28, insetT: 58, width: 92, height: 92, radius: 46 }}
      >
        <Label x={0} y={0} w={84} h={84} text={() => RANK_LETTERS[r()?.rank ?? 0]} size="hero" tone={rankTone(r()?.rank ?? 0)} />
      </View>
      <Show when={r()?.newBest}>
        <Chip x={28} y={158} w={92} h={20} text="NEW BEST" tone="amber" size="xsb" textTone="night" />
      </Show>

      <LeftLabel x={150} y={54} w={110} h={12} text="SCORE" size="xs" tone="mist" />
      <LeftLabel x={150} y={66} w={200} h={28} text={() => `${r()?.score ?? 0}`} size="lg" tone="white" />
      <Row y={100} name="PERFECT" value={() => `${r()?.perfect ?? 0}`} tone="amber" />
      <Row y={118} name="GREAT" value={() => `${r()?.great ?? 0}`} tone="sky" />
      <Row y={136} name="MISS" value={() => `${r()?.miss ?? 0}`} tone="coral" />
      <Row y={154} name="MAX COMBO" value={() => `${r()?.maxCombo ?? 0}`} tone="white" />
      <Row y={172} name="ACCURACY" value={() => `${r()?.accuracy ?? 0}%`} tone="white" />

      <Button debugName="ResultRetry" x={28} y={192} w={150} h={34} text="RETRY" size="base" tone="amber" textTone="night" onPress={props.onRetry} />
      <Button debugName="ResultSongs" x={194} y={192} w={178} h={34} text="SONGS" size="base" tone="night" textTone="white" onPress={props.onSongs} />
    </View>
  );
}
