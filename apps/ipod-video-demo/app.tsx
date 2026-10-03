import Hero from "../hero/app.tsx";
import type { IpodVideoHeroProps } from "./app";

/**
 * Hero guest for the Rockbox plugin host on an iPod Video (5th generation).
 * The click wheel and buttons reach this component through the portable
 * PocketJS input contracts; MicroTS compiles it to native ARM code.
 */
export default function IpodVideoHero(_props: IpodVideoHeroProps) {
  return (
    <Hero
      actionLabel="Press Select"
      compact
      deviceLabel="running on a 2005 iPod."
      presentationHz={33}
      runtimeLabel="RUST + ROCKBOX"
    />
  );
}
