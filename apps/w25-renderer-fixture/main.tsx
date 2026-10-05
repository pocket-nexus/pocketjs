import { createSignal } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { BTN } from "@pocketjs/framework/input";
import { mount } from "@pocketjs/framework";
import { onButtonPress } from "@pocketjs/framework/lifecycle";

function RendererFixture() {
  const [crossPressed, setCrossPressed] = createSignal(false);
  onButtonPress(BTN.CROSS, () => setCrossPressed(true));

  return (
    <View class="relative w-full h-full overflow-hidden bg-[#202830]">
      <Text class="absolute left-[16] top-[10] text-sm font-bold text-white">W25 RENDER CHECK</Text>
      <Text class="absolute left-[24] top-[88] text-xs text-white">RECT / NESTED CLIP</Text>
      <Text class="absolute left-[184] top-[16] text-xs text-white">ALPHA + TRANSFORM</Text>
      <Text class="absolute left-[320] top-[24] text-xs text-white">PRESS A</Text>

      <View class="absolute left-[24] top-[108] w-[128] h-[88] overflow-hidden bg-[#204060]">
        <View class="absolute left-[32] top-[18] w-[72] h-[52] overflow-hidden bg-[#406020]">
          <View class="absolute left-[-8] top-[-8] w-[40] h-[36] bg-[#e03020]" />
        </View>
        <View class="absolute left-[88] top-[24] w-[60] h-[28] bg-[#f0b020]" />
      </View>

      <View class="absolute left-[184] top-[36] w-[80] h-[64] bg-[#000080]" />
      <Image
        class="absolute left-[196] top-[44] w-[32] h-[32]"
        src="alpha.png"
        style={{ translateX: 8, translateY: 6, scale: 1.25, opacity: 0.5 }}
      />

      <View class="absolute left-[320] top-[44] w-[112] h-[56] bg-[#101820]" />
      <View
        class="absolute left-[328] top-[78] w-[96] h-[12]"
        style={{ bgColor: crossPressed() ? "#20c060" : "#c02020" }}
      />
      <Text class="absolute left-[328] top-[50] text-xs text-white">
        {crossPressed() ? "A INPUT OK" : "WAITING FOR A"}
      </Text>
    </View>
  );
}

mount(() => <RendererFixture />);
