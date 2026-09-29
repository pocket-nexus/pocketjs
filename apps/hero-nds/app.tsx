import Hero from "../hero/app.tsx";
import { presentationHz } from "./app";

export default function App() {
  return (
    <Hero
      compact
      actionLabel="Press A / Tap"
      deviceLabel="Compiled Rust on Nintendo DS."
      headline="Hero on NDS."
      presentationHz={presentationHz}
      runtimeLabel="MICROTS + RUST"
    />
  );
}
