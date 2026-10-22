import Hero from "../../apps/hero/app.tsx";
import { reportAppAction } from "@pocketjs/framework/host";

export default function IPhone2GHero() {
  return (
    <Hero
      actionLabel="Tap Hero"
      deviceLabel="running on a 2007 touchscreen."
      headline="JSX on ARMv6."
      onAction={(count) => reportAppAction("hero_tap", count)}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + UIKIT"
    />
  );
}
