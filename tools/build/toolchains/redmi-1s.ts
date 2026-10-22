import manifest from "./redmi-1s/manifest.json";
import { BUILD_STD_NIGHTLY } from "../../../tools/build/toolchains/rust.ts";

export default { ...manifest, rust: { ...manifest.rust, toolchain: BUILD_STD_NIGHTLY } };
