import Hero from "../../apps/hero/app.tsx";
import { reportAppAction } from "@pocketjs/framework/host";

export default function MeizuM8Hero() {
  return (
    <Hero
      actionLabel="Tap Hero"
      deviceLabel="running on a 2009 Windows CE touchscreen."
      headline="JSX on M8"
      largeLayout
      onAction={(count) => reportAppAction("hero_tap", count)}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + GDI"
    />
  );
}
