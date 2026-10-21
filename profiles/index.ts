import profilePsp from "./psp.ts";
import profileVita from "./vita.ts";
import profile3dsDev from "./3ds-dev.ts";
import profilePocketbook from "./pocketbook.ts";
import profileWebApp from "./web-app.ts";
import profileMacosApp from "./macos-app.ts";
import profileLinuxApp from "./linux-app.ts";
import profileMacosWidget from "./macos-widget.ts";
import profileMotoGPlayDev from "./moto-g-play-dev.ts";
import profileRedmi1sDev from "./redmi-1s-dev.ts";
import profileBlackberryQnxDev from "./blackberry-qnx-dev.ts";
import profileMeizuM8Dev from "./meizu-m8-dev.ts";
import profileSymbianE7Dev from "./symbian-e7-dev.ts";
import profileIosDev from "./ios-dev.ts";
import profileIphone2gDev from "./iphone2g-dev.ts";
import profileIphone4sDev from "./iphone4s-dev.ts";
import profileIpodtouchDev from "./ipodtouch-dev.ts";
import profileIpodtouch4Dev from "./ipodtouch4-dev.ts";
import profileMacosEmbedded from "./macos-embedded.ts";
import profileGba from "./gba.ts";
import profileIpodnano from "./ipodnano.ts";

export const POCKET_PROFILES = {
  "psp": profilePsp,
  "vita": profileVita,
  "3ds-dev": profile3dsDev,
  "pocketbook": profilePocketbook,
  "web-app": profileWebApp,
  "macos-app": profileMacosApp,
  "linux-app": profileLinuxApp,
  "macos-widget": profileMacosWidget,
  "moto-g-play-dev": profileMotoGPlayDev,
  "redmi-1s-dev": profileRedmi1sDev,
  "blackberry-qnx-dev": profileBlackberryQnxDev,
  "meizu-m8-dev": profileMeizuM8Dev,
  "symbian-e7-dev": profileSymbianE7Dev,
  "ios-dev": profileIosDev,
  "iphone2g-dev": profileIphone2gDev,
  "iphone4s-dev": profileIphone4sDev,
  "ipodtouch-dev": profileIpodtouchDev,
  "ipodtouch4-dev": profileIpodtouch4Dev,
  "macos-embedded": profileMacosEmbedded,
  "gba": profileGba,
  "ipodnano": profileIpodnano,
} as const;

export type BuiltinProfileId = keyof typeof POCKET_PROFILES;
export {
  profilePsp,
  profileVita,
  profile3dsDev,
  profilePocketbook,
  profileWebApp,
  profileMacosApp,
  profileLinuxApp,
  profileMacosWidget,
  profileMotoGPlayDev,
  profileRedmi1sDev,
  profileBlackberryQnxDev,
  profileMeizuM8Dev,
  profileSymbianE7Dev,
  profileIosDev,
  profileIphone2gDev,
  profileIphone4sDev,
  profileIpodtouchDev,
  profileIpodtouch4Dev,
  profileMacosEmbedded,
  profileGba,
  profileIpodnano,
};
