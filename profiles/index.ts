import profilePspRuntime from "./psp-runtime.ts";
import profile3dsRuntime from "./3ds-runtime.ts";
import profilePsp from "./psp.ts";
import profileVita from "./vita.ts";
import profile3dsDev from "./3ds-dev.ts";
import profileWebApp from "./web-app.ts";
import profileMacosApp from "./macos-app.ts";
import profileLinuxApp from "./linux-app.ts";
import profileMacosWidget from "./macos-widget.ts";
import profileMacosEmbedded from "./macos-embedded.ts";
import profileGba from "./gba.ts";
import profileIpodnano from "./ipodnano.ts";

export const POCKET_PROFILES = {
  "psp": profilePsp,
  "psp-runtime": profilePspRuntime,
  "3ds-runtime": profile3dsRuntime,
  "vita": profileVita,
  "3ds-dev": profile3dsDev,
  "web-app": profileWebApp,
  "macos-app": profileMacosApp,
  "linux-app": profileLinuxApp,
  "macos-widget": profileMacosWidget,
  "macos-embedded": profileMacosEmbedded,
  "gba": profileGba,
  "ipodnano": profileIpodnano,
} as const;

export type BuiltinProfileId = keyof typeof POCKET_PROFILES;
export {
  profilePspRuntime,
  profile3dsRuntime,
  profilePsp,
  profileVita,
  profile3dsDev,
  profileWebApp,
  profileMacosApp,
  profileLinuxApp,
  profileMacosWidget,
  profileMacosEmbedded,
  profileGba,
  profileIpodnano,
};
