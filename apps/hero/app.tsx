import { mergeProps } from "solid-js";
import { idiv } from "@pocketjs/framework/solid/std";
import type { HeroProps } from "./app";
import HeroView from "./Hero.tsx";

/** Public entry shared by the standard guest, device guests, and MicroTS. */
export default function Hero(rawProps: HeroProps) {
  const props = mergeProps({
    actionLabel: "Press Circle",
    compact: false,
    deviceLabel: "running on a 2005 handheld.",
    headline: "",
    largeLayout: false,
    presentationHz: 60,
    runtimeLabel: "RUST + SCEGU",
    spinnerFrameStep: 0,
  }, rawProps);
  return (
    <HeroView
      actionLabel={props.actionLabel}
      compact={props.compact}
      deviceLabel={props.deviceLabel}
      headline={props.headline !== "" ? props.headline : `JSX at ${props.presentationHz} FPS.`}
      largeLayout={props.largeLayout}
      onAction={(count) => props.onAction?.(count)}
      presentationHz={props.presentationHz}
      runtimeLabel={props.runtimeLabel}
      spinnerDelay={props.spinnerFrameStep > 0 && props.presentationHz > 0
        ? idiv(props.spinnerFrameStep * 1000, props.presentationHz)
        : 100}
    />
  );
}
