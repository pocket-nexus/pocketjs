// The youtube service (tools/companion/services.ts). Not built yet.

import { jsonResponse, type ServiceContext, type ServiceProvider } from "../services.ts";

export function createYoutubeService(_context: ServiceContext): ServiceProvider {
  return {
    name: "youtube",
    async handle() {
      return jsonResponse(501, { error: "the youtube service is not built yet" });
    },
  };
}
