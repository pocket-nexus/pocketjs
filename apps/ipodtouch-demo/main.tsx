// @title PocketJS: iPod touch Hero
import { mount } from "@pocketjs/framework/solid";
import IPodTouchHero from "./app.tsx";
import { installIPodTouchEffectDriver } from "./channel.ts";

installIPodTouchEffectDriver();
mount(() => <IPodTouchHero />);
