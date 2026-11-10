import { reportAppAction } from "@pocketjs/framework/host";
import { createSignal, onMount } from "solid-js";
import { View, Text } from "@pocketjs/framework/components";
import Hero from "../hero/app.tsx";

function doFetch(): string {
  try {
    const h = (globalThis as any).net.start(JSON.stringify({url:'https://httpbin.org/get'}));
    if (h > 0) {
      const buf = new ArrayBuffer(262144);
      const n = (globalThis as any).net.take(h, buf);
      const ev = (globalThis as any).net.poll();
      if (ev && ev.indexOf('"status"') >= 0) {
        const m = ev.match(/"status":(\d+)/);
        const code = m ? m[1] : "???";
        return "HTTP " + code + " · " + n + " bytes";
      }
      return "OK · " + n + " bytes";
    }
    return "ERR: " + (globalThis as any).net.lastError();
  } catch(e: any) {
    return "ERR: " + e.message;
  }
}

export default function IPad2Hero() {
  const [netResult, setNetResult] = createSignal("tap to fetch");
  onMount(() => { setNetResult(doFetch()); });
  return (
    <View class="w-full h-full flex-col">
      <View class="flex-1">
        <Hero
          actionLabel="Fetch"
          deviceLabel="running on an iPad 2 (A1396)"
          headline="JSX on A5."
          onAction={() => setNetResult(doFetch())}
          presentationHz={60}
          runtimeLabel="RUST + QUICKJS + UIKIT"
          spinnerFrameStep={6}
        />
      </View>
      <View class="flex-row items-center p-2 bg-slate-900">
        <Text class="text-xs text-emerald-400 font-mono">{netResult()}</Text>
      </View>
    </View>
  );
}
