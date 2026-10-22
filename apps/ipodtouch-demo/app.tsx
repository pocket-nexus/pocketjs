import { runEffect } from "@pocketjs/framework/effects";
import Hero from "../../apps/hero/app.tsx";

export default function IPodTouchHero() {
  return (
    <Hero
      actionLabel="Tap Hero"
      deviceLabel="running on a 2015 iPod touch."
      headline="JSX on A8."
      onAction={(count) => runEffect("ipodtouch.hero_tap", { count }, () => {})}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + UIKIT"
    />
  );
}
