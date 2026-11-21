// @title NS Engine — pocketjs guest talking to a NativeScript host
import { createSignal, onMount } from "solid-js";
import { Image, Screen, Sprite, Text, View } from "@pocketjs/framework/components";
import { runEffect } from "@pocketjs/framework/effects";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { pumpHostLines } from "./channel.ts";

// Bakes the glyphs dynamic host strings may use (digits, punctuation).
const GLYPH_SEED = "0123456789 #:{}\"pong hello from NativeScript,.!?-_iOS via sandboxed realm";

// In a sidecar realm (Direction A) no platform globals exist; when the
// NativeScript runtime is the guest engine (Direction B), the whole iOS
// surface is one identifier away.
declare const UIDevice: { currentDevice: { systemVersion: string } } | undefined;
const platformReach = typeof UIDevice !== "undefined"
  ? `iOS ${UIDevice!.currentDevice.systemVersion} via NativeScript`
  : "sandboxed realm";

function Stat(props: { label: string; value: string; valueClass: string }) {
  return (
    <View class="flex-col flex-1 gap-1 rounded-lg bg-slate-800 p-3 shadow">
      <Text class="text-xs text-slate-400 tracking-wide">{props.label}</Text>
      <Text class={props.valueClass}>{props.value}</Text>
    </View>
  );
}

export default function App() {
  const [reply, setReply] = createSignal("waiting");
  const [hostEvent, setHostEvent] = createSignal("none yet");
  const [count, setCount] = createSignal(0);
  onFrame(() => pumpHostLines((message) => {
    setHostEvent(String(message["msg"] ?? JSON.stringify(message)));
  }));

  const ping = () => {
    const n = count() + 1;
    setCount(n);
    runEffect("ns.ping", { n }, (result) => setReply(String(result)));
  };

  // Fire one round trip unprompted so the channel proves itself on boot.
  onMount(() => ping());

  return (
    <Screen class="relative flex-col w-full h-full overflow-hidden justify-between p-5 bg-gradient-to-b from-slate-950 to-slate-900">
      <View class="flex-row items-center justify-between">
        <View class="flex-row items-center gap-3">
          <Image class="w-10 h-10 rounded-lg shadow" src="logo.png" />
          <View class="flex-col">
            <Text class="text-base text-white font-bold tracking-wide">
              PocketJS × NativeScript
            </Text>
            <Text class="text-xs text-slate-400 tracking-wide">
              one Rust core · two JS worlds
            </Text>
          </View>
        </View>
        <Sprite class="w-8 h-8" sprite="spinner-atlas.svg" />
      </View>

      <View class="flex-row gap-3">
        <Stat label="guest → host" value={reply()} valueClass="text-xs font-bold text-cyan-400" />
        <Stat label="host → guest" value={hostEvent()} valueClass="text-xs font-bold text-blue-400" />
        <Stat label="platform" value={platformReach} valueClass="text-xs font-bold text-emerald-400" />
      </View>

      <View class="flex-row items-center gap-4">
        <View class="rounded-xl bg-blue-600 px-5 py-2 shadow" focusable onPress={ping}>
          <Text class="text-sm font-bold text-white">Ping host · {count()}</Text>
        </View>
        <View class="h-1 flex-1 rounded bg-gradient-to-r from-blue-500 to-cyan-500" />
      </View>
      <Text class="text-slate-900">{GLYPH_SEED}</Text>
    </Screen>
  );
}
