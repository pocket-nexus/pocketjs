import Hero from "../../apps/hero/app.tsx";
import { TICKS_PER_SECOND } from "@pocketjs/framework/clock";

export default function IPhone16Hero() {
  return (
    <Hero
      actionLabel="Tap Me"
      deviceLabel="running on an iPhone 16 Pro, iOS 26.5."
      presentationHz={TICKS_PER_SECOND}
      runtimeLabel="RUST + QUICKJS + UIKIT"
    />
  );
}
