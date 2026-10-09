import type { JSX } from "solid-js";
import { Focusable, Image, View } from "@pocketjs/framework/components";
import {
  UNKNOWN_TEMP,
  type DashboardStatus,
  type MusicStatus,
} from "../native.ts";
import {
  Button,
  Chip,
  DiscIcon,
  Label,
  LeftLabel,
  MenuIcon,
  Panel,
  Ring,
  RoundButton,
  SunIcon,
  WifiIcon,
  clampPercent,
} from "../ui/kit.tsx";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function compactTemperature(value: number): string {
  if (value <= UNKNOWN_TEMP) return "N/A";
  return `${Math.round(value / 10)}C`;
}

function shorten(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}.` : text;
}

function musicState(state: number): string {
  if (state === 1) return "Playing";
  if (state === 2) return "Paused";
  if (state === 3) return "No audio";
  return "Stopped";
}

export interface HomeProps {
  status: () => DashboardStatus;
  music: () => MusicStatus;
  bestScore: () => number;
  musicCommand: (command: number) => void;
  onPlay: () => void;
  onSettings: () => void;
  onCalendar: () => void;
  onPc: () => void;
}

export function Home(props: HomeProps): JSX.Element {
  const weather = () => {
    const s = props.status();
    return s.weatherTemp > UNKNOWN_TEMP ? compactTemperature(s.weatherTemp) : "--";
  };
  const host = () => {
    const s = props.status();
    if (s.wifi && s.ip !== "") return s.ip;
    if (s.ap) return "192.168.169.1";
    return "--";
  };
  const wifiText = () => {
    const s = props.status();
    if (s.wifi) return shorten(s.ssid, 9);
    return s.ap ? "Setup" : "Offline";
  };
  const date = () => {
    const s = props.status();
    return s.month < 1 ? "-- --" : `${MONTHS[Math.min(11, s.month - 1)]} ${s.day}`;
  };
  const playLabel = () => (props.music().state === 1 ? "||" : ">");

  return (
    <View debugName="Home" class="absolute left-0 top-0 w-[400] h-[240] bg-[#e6eff3] overflow-hidden">
      {/* Header */}
      <Image class="absolute w-[28] h-[28]" style={{ insetL: 12, insetT: 6 }} src="avatar.png" />
      <LeftLabel x={48} y={5} w={90} h={16} text="SRAKOUL" size="sm" tone="ink" />
      <LeftLabel x={48} y={21} w={32} h={12} text="HOST" size="xs" tone="sub" />
      <LeftLabel x={80} y={20} w={82} h={14} text={host} size="xs" tone="teal" />

      <View
        class="absolute bg-[#d5e8e9]"
        style={{ insetL: 166, insetT: 10, width: 46, height: 20, radius: 10 }}
      >
        <SunIcon x={7} y={2} />
        <Label x={24} y={0} w={36} h={20} text={weather} size="xs" tone="ink" />
      </View>

      <Focusable
        debugName="WifiChip"
        class="absolute bg-[#d5e8e9] active:bg-[#bcd8da]"
        style={{ insetL: 216, insetT: 10, width: 80, height: 20, radius: 10 }}
        onPress={props.onSettings}
      >
        <WifiIcon x={8} y={3} on={props.status().wifi} />
        <Label x={26} y={0} w={52} h={20} text={wifiText} size="xs" tone="ink" />
      </Focusable>

      <Focusable
        debugName="DateChip"
        class="absolute bg-[#d5e8e9] active:bg-[#bcd8da] items-center justify-center"
        style={{ insetL: 302, insetT: 10, width: 52, height: 20, radius: 10 }}
        onPress={props.onCalendar}
      >
        <Label x={0} y={0} w={52} h={20} text={date} size="xsb" tone="ink" />
      </Focusable>

      <Focusable
        debugName="SettingsEntry"
        class="absolute bg-[#d5e8e9] active:bg-[#bcd8da] items-center justify-center"
        style={{ insetL: 362, insetT: 8, width: 26, height: 24, radius: 12 }}
        onPress={props.onSettings}
      >
        <MenuIcon x={6} y={7} />
      </Focusable>

      {/* Hero card */}
      <View
        class="absolute rounded-[16px] bg-gradient-to-b from-[#12304a] to-[#0b1622] overflow-hidden"
        style={{ insetL: 12, insetT: 42, width: 190, height: 126 }}
      >
        <LeftLabel x={14} y={10} w={110} h={22} text="BEAT DASH" size="lg" tone="white" />
        <LeftLabel x={14} y={32} w={110} h={14} text="Rhythm runner" size="xs" tone="mist" />
        <Image class="absolute w-[56] h-[56]" style={{ insetL: 124, insetT: 10 }} src="avatar.png" />
        <Chip x={14} y={56} w={112} h={18} text={() => `BEST ${props.bestScore()}`} tone="night" size="xsb" textTone="amber" />
        <Button
          debugName="PlayEntry"
          x={14}
          y={84}
          w={162}
          h={30}
          text="PLAY"
          size="base"
          tone="amber"
          textTone="night"
          onPress={props.onPlay}
        />
      </View>

      {/* System card */}
      <Panel x={210} y={42} w={178} h={126}>
        <Ring x={20} y={8} caption="CPU" value={() => `${clampPercent(props.status().cpu)}%`} percent={() => props.status().cpu} />
        <Ring x={109} y={8} caption="RAM" value={() => `${clampPercent(props.status().ram)}%`} percent={() => props.status().ram} />
        <Ring
          x={20}
          y={66}
          caption={props.status().tempSource === 2 ? "IMU" : "TEMP"}
          value={() => compactTemperature(props.status().temp)}
          percent={() => (props.status().temp > UNKNOWN_TEMP ? Math.min(100, Math.max(0, props.status().temp / 10)) : 0)}
        />
        <Ring x={109} y={66} caption="FPS" value={() => `${props.status().fps}`} percent={() => Math.min(100, (props.status().fps * 100) / 30)} />
        {/* Tapping the system card opens the PC monitor. */}
        <Focusable
          debugName="PcEntry"
          class="absolute"
          style={{ insetL: 0, insetT: 0, width: 178, height: 126 }}
          onPress={props.onPc}
        />
      </Panel>

      {/* Music bar */}
      <Panel x={12} y={176} w={376} h={52}>
        <DiscIcon x={10} y={9} size={34} />
        <LeftLabel x={54} y={8} w={126} h={18} text={() => shorten(props.music().track, 14)} size="sm" tone="ink" />
        <LeftLabel
          x={54}
          y={27}
          w={126}
          h={14}
          text={() => `${musicState(props.music().state)}  ${props.music().index + 1}/${props.music().count}`}
          size="xs"
          tone="sub"
        />
        <RoundButton debugName="MusicPrev" x={186} y={12} size={28} text="<" onPress={() => props.musicCommand(2)} />
        <RoundButton debugName="MusicToggle" x={220} y={10} size={32} text={playLabel} tone="solid" textTone="white" onPress={() => props.musicCommand(1)} />
        <RoundButton debugName="MusicNext" x={258} y={12} size={28} text=">" onPress={() => props.musicCommand(3)} />
        <RoundButton debugName="VolumeDown" x={298} y={15} size={22} text="-" onPress={() => props.musicCommand(4)} />
        <Label x={320} y={0} w={30} h={52} text={() => `${props.music().volume}`} size="xsb" tone="ink" />
        <RoundButton debugName="VolumeUp" x={350} y={15} size={22} text="+" onPress={() => props.musicCommand(5)} />
      </Panel>
    </View>
  );
}
