// The x service (tools/companion/services.ts). Not built yet.

import { jsonResponse, type ServiceContext, type ServiceProvider } from "../services.ts";

export function createXService(_context: ServiceContext): ServiceProvider {
  return {
    name: "x",
    async handle() {
      return jsonResponse(501, { error: "the x service is not built yet" });
    },
  };
}
