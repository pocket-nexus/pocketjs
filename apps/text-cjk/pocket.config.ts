import { definePocketConfig } from "@pocketjs/framework/config";

// Pending placeholders animate on the UI thread without requesting glyphs.
export default definePocketConfig({
  theme: {
    keyframes: {
      "skeleton-pulse": {
        from: { opacity: 0.35 },
        "50%": { opacity: 0.9 },
        to: { opacity: 0.35 },
      },
    },
    animation: {
      "skeleton-pulse": {
        value: "skeleton-pulse 1600ms linear both",
        loop: "1600ms",
      },
    },
  },
});
