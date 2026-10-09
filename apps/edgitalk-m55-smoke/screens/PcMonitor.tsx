import type { JSX } from "solid-js";
import { View } from "@pocketjs/framework/components";
import type { PcStats } from "../native.ts";
import { Bar, Button, LeftLabel, Label, Panel, Ring } from "../ui/kit.tsx";

/** A PC counts as online while its last packet is younger than this. */
export const PC_ONLINE_MS = 8000;

function gb(megabytes: number): string {
  return `${(megabytes / 1024).toFixed(1)}`;
}

export interface PcMonitorProps {
  pc: () => PcStats;
  onBack: () => void;
}

/** CPU, RAM, disk and temperature of the PC that runs the companion console. */
export function PcMonitor(props: PcMonitorProps): JSX.Element {
  const live = () => props.pc().seen;
  const online = () => live() && props.pc().ageMs <= PC_ONLINE_MS;
  const state = () => (!live() ? "WAITING" : online() ? "ONLINE" : "OFFLINE");
  const percent = (value: () => number) => () => (live() ? value() : 0);
  const percentText = (value: () => number) => () => (live() ? `${value()}%` : "--");
  const tempKnown = () => live() && props.pc().temp >= 0;

  const memory = () => {
    const p = props.pc();
    return live() && p.ramTotalMb > 0 ? `${gb(p.ramUsedMb)} / ${gb(p.ramTotalMb)} GB` : "--";
  };
  const disk = () => {
    const p = props.pc();
    return live() && p.diskTotalGb > 0 ? `${p.diskUsedGb} / ${p.diskTotalGb} GB` : "--";
  };
  const host = () => {
    const p = props.pc();
    return live() ? p.host : "no PC yet";
  };
  const age = () => {
    const p = props.pc();
    if (!live()) return "start the console";
    return p.ageMs < 1500 ? "live" : `${Math.round(p.ageMs / 1000)}s ago`;
  };

  return (
    <View debugName="PcMonitor" class="absolute left-0 top-[1440] w-[400] h-[240] bg-[#e6eff3] overflow-hidden">
      <Button debugName="PcBack" x={12} y={9} w={64} h={22} text="< Home" tone="light" onPress={props.onBack} />
      <Label x={120} y={8} w={160} h={24} text="PC MONITOR" size="lg" tone="ink" />
      <View
        class="absolute bg-[#d5e8e9]"
        style={{ insetL: 296, insetT: 10, width: 92, height: 20, radius: 10 }}
      >
        <View
          class={online() ? "absolute bg-[#1d7974]" : "absolute bg-[#ff6f7d]"}
          style={{ insetL: 10, insetT: 6, width: 8, height: 8, radius: 4 }}
        />
        <Label x={20} y={0} w={70} h={20} text={state} size="xsb" tone="ink" />
      </View>

      <Panel x={12} y={44} w={376} h={88}>
        <Ring x={23} y={14} caption="CPU" value={percentText(() => props.pc().cpu)} percent={percent(() => props.pc().cpu)} />
        <Ring x={117} y={14} caption="RAM" value={percentText(() => props.pc().ram)} percent={percent(() => props.pc().ram)} />
        <Ring x={211} y={14} caption="DISK" value={percentText(() => props.pc().disk)} percent={percent(() => props.pc().disk)} />
        <Ring
          x={305}
          y={14}
          caption="TEMP"
          value={() => (tempKnown() ? `${props.pc().temp}C` : "N/A")}
          percent={() => (tempKnown() ? Math.min(100, props.pc().temp) : 0)}
        />
      </Panel>

      <Panel x={12} y={140} w={376} h={88}>
        <LeftLabel x={14} y={6} w={80} h={14} text="MEMORY" size="xsb" tone="sub" />
        <Label x={190} y={6} w={172} h={14} text={memory} size="xs" tone="ink" />
        <Bar x={14} y={22} w={348} h={8} fraction={() => (live() ? props.pc().ram / 100 : 0)} />
        <LeftLabel x={14} y={36} w={80} h={14} text="DISK" size="xsb" tone="sub" />
        <Label x={190} y={36} w={172} h={14} text={disk} size="xs" tone="ink" />
        <Bar x={14} y={52} w={348} h={8} fraction={() => (live() ? props.pc().disk / 100 : 0)} />
        <LeftLabel x={14} y={66} w={170} h={14} text={() => `HOST  ${host()}`} size="xs" tone="sub" />
        <Label x={190} y={66} w={172} h={14} text={age} size="xs" tone="sub" />
      </Panel>
    </View>
  );
}
