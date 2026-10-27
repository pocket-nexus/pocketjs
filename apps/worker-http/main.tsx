import { createSignal } from "solid-js";
import { mount } from "@pocketjs/framework/solid";
import { Text, View } from "@pocketjs/framework/components";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { io } from "@pocketjs/framework/io";

function App() {
  const request = io.channel("request");
  const progress = io.channel("progress");
  const [state, setState] = createSignal("Ready");
  const [bytes, setBytes] = createSignal(0);
  const [status, setStatus] = createSignal(0);
  const phases = ["Ready", "Request accepted", "Headers received", "Receiving body", "Complete", "Request failed"];
  onButtonPress(BTN.CROSS, () => { request.publish(Uint8Array.of(1)); });
  onFrame(() => {
    for (const record of progress.observe()) {
      setState(phases[record.u32(0)] ?? "Unknown");
      setBytes(record.u32(4));
      setStatus(new DataView(record.copy().buffer).getInt32(8, true));
    }
  });
  return <View class="w-full h-full bg-slate-950 p-6 gap-3">
    <Text class="text-xl text-white">Worker HTTP</Text>
    <Text class="text-sm text-slate-300">Pair Pocket Link, then press A to request.</Text>
    <Text class="text-lg text-white">{state()}</Text>
    <Text class="text-sm text-slate-300">Bytes: {bytes()} / status: {status()}</Text>
  </View>;
}
mount(() => <App />);
