// The built-in profile documents (profiles/*.json), checked and frozen.
import { builtinProfile, type PocketProfile } from "../framework/src/profile.ts";
import profilePspDocument from "./psp.json" with { type: "json" };
import profilePspRuntimeDocument from "./psp-runtime.json" with { type: "json" };
import profileP3dsRuntimeDocument from "./3ds-runtime.json" with { type: "json" };
import profileVitaDocument from "./vita.json" with { type: "json" };
import profileP3dsDevDocument from "./3ds-dev.json" with { type: "json" };
import profileWebAppDocument from "./web-app.json" with { type: "json" };
import profileMacosAppDocument from "./macos-app.json" with { type: "json" };
import profileLinuxAppDocument from "./linux-app.json" with { type: "json" };
import profileMacosWidgetDocument from "./macos-widget.json" with { type: "json" };
import profileMacosEmbeddedDocument from "./macos-embedded.json" with { type: "json" };
import profileGbaDocument from "./gba.json" with { type: "json" };
import profileIpodnanoDocument from "./ipodnano.json" with { type: "json" };
import profilePocketbookDocument from "./pocketbook.json" with { type: "json" };
import profileMotoGPlayDevDocument from "./moto-g-play-dev.json" with { type: "json" };
import profileRedmi1sDevDocument from "./redmi-1s-dev.json" with { type: "json" };
import profileBlackberryQnxDevDocument from "./blackberry-qnx-dev.json" with { type: "json" };
import profileMeizuM8DevDocument from "./meizu-m8-dev.json" with { type: "json" };
import profileSymbianE7DevDocument from "./symbian-e7-dev.json" with { type: "json" };
import profileIosDevDocument from "./ios-dev.json" with { type: "json" };
import profileIphone2gDevDocument from "./iphone2g-dev.json" with { type: "json" };
import profileIphone4sDevDocument from "./iphone4s-dev.json" with { type: "json" };
import profileIpodtouchDevDocument from "./ipodtouch-dev.json" with { type: "json" };
import profileIpodtouch4DevDocument from "./ipodtouch4-dev.json" with { type: "json" };

export const POCKET_PROFILES = {
  "psp": builtinProfile(profilePspDocument),
  "psp-runtime": builtinProfile(profilePspRuntimeDocument),
  "3ds-runtime": builtinProfile(profileP3dsRuntimeDocument),
  "vita": builtinProfile(profileVitaDocument),
  "3ds-dev": builtinProfile(profileP3dsDevDocument),
  "web-app": builtinProfile(profileWebAppDocument),
  "macos-app": builtinProfile(profileMacosAppDocument),
  "linux-app": builtinProfile(profileLinuxAppDocument),
  "macos-widget": builtinProfile(profileMacosWidgetDocument),
  "macos-embedded": builtinProfile(profileMacosEmbeddedDocument),
  "gba": builtinProfile(profileGbaDocument),
  "ipodnano": builtinProfile(profileIpodnanoDocument),
  "pocketbook": builtinProfile(profilePocketbookDocument),
  "moto-g-play-dev": builtinProfile(profileMotoGPlayDevDocument),
  "redmi-1s-dev": builtinProfile(profileRedmi1sDevDocument),
  "blackberry-qnx-dev": builtinProfile(profileBlackberryQnxDevDocument),
  "meizu-m8-dev": builtinProfile(profileMeizuM8DevDocument),
  "symbian-e7-dev": builtinProfile(profileSymbianE7DevDocument),
  "ios-dev": builtinProfile(profileIosDevDocument),
  "iphone2g-dev": builtinProfile(profileIphone2gDevDocument),
  "iphone4s-dev": builtinProfile(profileIphone4sDevDocument),
  "ipodtouch-dev": builtinProfile(profileIpodtouchDevDocument),
  "ipodtouch4-dev": builtinProfile(profileIpodtouch4DevDocument),
} as const satisfies Readonly<Record<string, PocketProfile>>;

export type BuiltinProfileId = keyof typeof POCKET_PROFILES;
/** The file of a built-in profile, relative to this directory. */
export const builtinProfileFile = (id: BuiltinProfileId): string => `${id}.json`;
