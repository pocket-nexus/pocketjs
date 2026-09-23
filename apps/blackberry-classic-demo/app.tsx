import Hero from "../hero/app.tsx";
import { reportAppAction } from "@pocketjs/framework/host";

/**
 * Hero guest for the BlackBerry Classic native QNX host. Device events reach
 * this component through the portable PocketJS input contracts.
 */
export default function BlackBerryClassicHero() {
  return (
    <Hero
      actionLabel="CLICK OR TAP"
      deviceLabel="running on a BlackBerry Classic."
      headline="JSX on Classic."
      onAction={(count) => reportAppAction("hero_press", count)}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + GLES2"
      spinnerFrameStep={6}
    />
  );
}
