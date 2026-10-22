import manifest from "./meizu-m8/manifest.json";
import { BUILD_STD_NIGHTLY } from "../../../tools/build/toolchains/rust.ts";

export default { ...manifest, compiler: { ...manifest.compiler, rustToolchain: BUILD_STD_NIGHTLY } };
