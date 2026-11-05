// @title Pocket Nexus
// The Nokia E7 held in portrait: the same scene on the homepage's 360x640 layout.
import Nexus from "../app.tsx";
import * as art from "./art.ts";
import { mount } from "@pocketjs/framework/solid";

mount(() => <Nexus art={art} />);
