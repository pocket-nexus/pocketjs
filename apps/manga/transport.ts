import { attachRelaySession, relayChannel } from "@pocketjs/framework/relay/channel";
import { offload } from "@pocketjs/framework/offload";
import { resourcePackCache } from "./pack-client.ts";
import type { MangaCache, MangaTransport } from "./client.ts";
import { createRelayMangaClient } from "./relay-client.ts";
import { MANGA_RELAY, mangaRelayLimits } from "./relay-profile.ts";

/** Same channel selection as Pocket Map: hosts publishing the byte lane
 * use Relay; existing native builds keep their companion offload path. */
export function mangaTransport(): { remote?: MangaTransport; cache?: MangaCache; close(): void; protocol: "relay" | "offload" } {
  const channel = relayChannel({ id: "companion", grants: [MANGA_RELAY.app] }), cache = resourcePackCache();
  if (channel) {
    const remote = createRelayMangaClient({ transport: channel.transport, rxLimits: mangaRelayLimits(true) });
    attachRelaySession(channel, remote);
    return { remote, protocol: "relay", close() { channel.close(); remote.close(); },
      cache: cache?.pixels ? { ...cache, image(pack, entry, ticket, callback) {
        const image = remote.pixels(ticket);
        return cache.pixels!(pack, entry, image.pixels, image.width, image.height, callback);
      } } : undefined };
  }
  let remote: MangaTransport | undefined;
  try { remote = offload(); } catch { /* The installed library needs no companion. */ }
  return { remote, cache, protocol: "offload", close() {} };
}
