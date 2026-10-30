// Cadence probe for tests/desktop-cadence.test.ts: reports the latched
// simulation rate at mount and the virtual frame at which after(1.5) fires.
import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";
import { after, simulationHz, virtualFrame } from "@pocketjs/framework/clock";

function Probe() {
  console.log(`PROBE armed simHz=${simulationHz()}`);
  after(1.5, () => console.log(`PROBE fired frame=${virtualFrame()} simHz=${simulationHz()}`));
  return <View class="w-full h-full bg-[#203040]" />;
}

mount(() => <Probe />);
