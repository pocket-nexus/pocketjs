// @title Pocket Nexus
import Nexus from "./app.tsx";
import * as art from "./art.ts";
import { mount } from "@pocketjs/framework/solid";

mount(() => <Nexus art={art} />);
