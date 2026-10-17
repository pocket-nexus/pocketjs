import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { Focusable, View } from "@pocketjs/framework/components";
import type { GameScores } from "../native.ts";
import type { Song } from "../game/songs.ts";
import { Button, Chip, Label } from "../ui/kit.tsx";

const LEVEL_NAMES = ["", "EASY", "NORMAL", "HARD"];

/** Cover gradient per song slot; whole literals so the build can resolve them. */
function coverClass(id: number, custom: boolean): string {
  if (custom) return "absolute left-0 top-0 w-[88] h-[84] bg-gradient-to-b from-[#7be0c8] to-[#3aa6b9]";
  if (id === 0) return "absolute left-0 top-0 w-[88] h-[84] bg-gradient-to-b from-[#ffd98a] to-[#ff9f5a]";
  if (id === 1) return "absolute left-0 top-0 w-[88] h-[84] bg-gradient-to-b from-[#8fb4ff] to-[#5a5cf0]";
  return "absolute left-0 top-0 w-[88] h-[84] bg-gradient-to-b from-[#ff9db0] to-[#e0456f]";
}

function Pips(props: { x: number; y: number; level: number }): JSX.Element {
  const pip = (index: number) => (
    <View
      class={index < props.level ? "absolute w-[10] h-[10] bg-[#ff6f7d]" : "absolute w-[10] h-[10] bg-[#d5e0e4]"}
      style={{ insetL: index * 14, insetT: 0, radius: 5 }}
    />
  );
  return (
    <View class="absolute w-[38] h-[10]" style={{ insetL: props.x, insetT: props.y }}>
      {pip(0)}
      {pip(1)}
      {pip(2)}
    </View>
  );
}

function SongCard(props: {
  slot: number;
  song: () => Song | undefined;
  scores: () => GameScores;
  onPick: (song: Song) => void;
}): JSX.Element {
  const song = () => props.song();
  const best = () => props.scores().best[props.slot] ?? 0;
  const rank = () => props.scores().rank[props.slot] ?? "-";
  return (
    <Focusable
      debugName={`SongCard${props.slot}`}
      class="absolute rounded-[16px] border border-[#cbdde3] bg-[#f7fafb] active:bg-[#eaf3f6] overflow-hidden"
      style={{ insetL: 12 + props.slot * 96, insetT: 44, width: 88, height: 180 }}
      onPress={() => {
        const s = song();
        if (s) props.onPick(s);
      }}
    >
      <View class={coverClass(props.slot, props.slot === 3)} />
      <Show
        when={song()}
        fallback={
          <>
            <Label x={0} y={22} w={88} h={40} text="PC" size="hero" tone="white" />
            <Label x={0} y={92} w={88} h={16} text="Custom" size="xsb" tone="ink" />
            <Label x={4} y={116} w={80} h={14} text="No song yet" size="xs" tone="sub" />
            <Label x={4} y={132} w={80} h={14} text="Send from PC" size="xs" tone="sub" />
          </>
        }
      >
        <Chip x={8} y={8} w={52} h={16} text={() => LEVEL_NAMES[song()?.level ?? 1]} tone="light" size="xsb" textTone="ink" />
        <Label x={0} y={26} w={88} h={40} text={() => `${song()?.bpm ?? 0}`} size="hero" tone="white" />
        <Label x={0} y={64} w={88} h={14} text="BPM" size="xsb" tone="white" />
        <Label x={0} y={90} w={88} h={16} text={() => song()?.title ?? ""} size="xsb" tone="ink" />
        <Pips x={25} y={114} level={song()?.level ?? 1} />
        <Label x={0} y={130} w={88} h={12} text="BEST" size="xs" tone="sub" />
        <Label x={0} y={142} w={88} h={16} text={() => `${best()}`} size="sm" tone="ink" />
        <Chip
          x={26}
          y={158}
          w={36}
          h={16}
          text={rank}
          tone={rank() === "-" ? "soft" : "solid"}
          size="xsb"
          textTone={rank() === "-" ? "sub" : "white"}
        />
      </Show>
    </Focusable>
  );
}

export interface SongsProps {
  songs: () => Song[];
  scores: () => GameScores;
  onPick: (song: Song) => void;
  onBack: () => void;
}

export function Songs(props: SongsProps): JSX.Element {
  const slots = [0, 1, 2, 3];
  return (
    <View debugName="Songs" class="absolute left-0 top-[240] w-[400] h-[240] bg-[#e6eff3] overflow-hidden">
      <Button debugName="SongsBack" x={12} y={9} w={64} h={22} text="< Home" tone="light" onPress={props.onBack} />
      <Label x={120} y={8} w={160} h={24} text="SELECT SONG" size="lg" tone="ink" />
      <Label x={290} y={9} w={98} h={22} text="Tap to play" size="xs" tone="sub" />
      <For each={slots}>
        {(slot) => (
          <SongCard
            slot={slot}
            song={() => props.songs().find((s) => s.id === slot)}
            scores={props.scores}
            onPick={props.onPick}
          />
        )}
      </For>
    </View>
  );
}
