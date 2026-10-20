// The discord service (tools/companion/services.ts). Not built yet.

import { jsonResponse, type ServiceContext, type ServiceProvider } from "../services.ts";

export function createDiscordService(_context: ServiceContext): ServiceProvider {
  return {
    name: "discord",
    async handle() {
      return jsonResponse(501, { error: "the discord service is not built yet" });
    },
  };
}
