import { reportAppAction } from "@pocketjs/framework/host";
import Hero from "../hero/app.tsx";

export default function IPhone4SHero() {
  return (
    <Hero
      actionLabel="Tap Hero"
      deviceLabel="running on an iPad 2 (A1396)"
      headline="JSX on A5."
      onAction={(count) => reportAppAction("hero_tap", count)}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + UIKIT"
      spinnerFrameStep={6}
    />
  );
}
