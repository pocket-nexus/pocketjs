import type { JSX } from "solid-js";
import type { DashboardStatus } from "../native.ts";
import { Button, Label, LeftLabel, Panel, RoundButton } from "../ui/kit.tsx";
import { View } from "@pocketjs/framework/components";

function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}.` : text;
}

export interface SettingsProps {
  status: () => DashboardStatus;
  offset: () => number;
  onOffset: (delta: number) => void;
  onBack: () => void;
  onPc: () => void;
}

export function Settings(props: SettingsProps): JSX.Element {
  const state = () => {
    const s = props.status();
    if (s.wifi) return "Connected";
    return s.ap ? "Setup mode" : "Offline";
  };
  const line1 = () => {
    const s = props.status();
    if (s.wifi) return `SSID  ${shorten(s.ssid, 16)}`;
    return s.ap ? `Hotspot  ${shorten(s.apSsid, 14)}` : "Waiting for saved network";
  };
  /** Address to type into the PC tool's Board field. */
  const host = () => {
    const s = props.status();
    if (s.wifi && s.ip !== "") return `${s.ip}:80`;
    if (s.ap) return "192.168.169.1:80";
    return "--";
  };
  const line3 = () => {
    const s = props.status();
    return !s.wifi && s.ap ? `Password  ${s.apPassword}` : "";
  };
  const code = () => {
    const token = props.status().token;
    return token === "" ? "--" : token;
  };

  return (
    <View debugName="Settings" class="absolute left-0 top-[960] w-[400] h-[240] bg-[#e6eff3] overflow-hidden">
      <Button debugName="SettingsBack" x={12} y={9} w={64} h={22} text="< Home" tone="light" onPress={props.onBack} />
      <Label x={120} y={8} w={160} h={24} text="SETTINGS" size="lg" tone="ink" />

      <Panel x={12} y={44} w={188} h={184}>
        <LeftLabel x={14} y={10} w={160} h={14} text="NETWORK" size="xsb" tone="sub" />
        <LeftLabel x={14} y={30} w={164} h={18} text={state} size="sm" tone="teal" />
        <LeftLabel x={14} y={52} w={160} h={12} text="HOST" size="xsb" tone="sub" />
        <LeftLabel x={14} y={66} w={164} h={20} text={host} size="xs" tone="teal" />
        <LeftLabel x={14} y={88} w={168} h={16} text={line1} size="xs" tone="ink" />
        <LeftLabel x={14} y={104} w={168} h={16} text={line3} size="xs" tone="ink" />
        <LeftLabel x={14} y={124} w={164} h={14} text={() => (props.status().bt ? "BT EdgiTalk" : "BT offline")} size="xs" tone="teal" />
        <LeftLabel x={14} y={138} w={164} h={14} text="tool, then the pair code." size="xs" tone="sub" />
        <Button debugName="PcMonitorEntry" x={14} y={152} w={160} h={24} text="PC Monitor >" tone="soft" onPress={props.onPc} />
      </Panel>

      <Panel x={208} y={44} w={180} h={104}>
        <LeftLabel x={14} y={10} w={150} h={14} text="AUDIO OFFSET" size="xsb" tone="sub" />
        <RoundButton debugName="OffsetDown" x={14} y={30} size={28} text="-" onPress={() => props.onOffset(-10)} />
        <Label x={46} y={28} w={88} h={32} text={() => `${props.offset()} ms`} size="lg" tone="ink" />
        <RoundButton debugName="OffsetUp" x={138} y={30} size={28} text="+" onPress={() => props.onOffset(10)} />
        <Label x={0} y={68} w={180} h={14} text="Notes look late: raise" size="xs" tone="sub" />
        <Label x={0} y={82} w={180} h={14} text="Notes look early: lower" size="xs" tone="sub" />
      </Panel>

      <Panel x={208} y={156} w={180} h={72}>
        <LeftLabel x={14} y={10} w={150} h={14} text="PC PAIR CODE" size="xsb" tone="sub" />
        <Label x={0} y={26} w={180} h={26} text={code} size="lg" tone="teal" />
        <Label x={0} y={52} w={180} h={14} text="Needed to upload songs" size="xs" tone="sub" />
      </Panel>
    </View>
  );
}
