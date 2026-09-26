// Six independent AppInstances; the 3DS owns both its primary and auxiliary LCD.
export const DESK_APPS = [
  { device: "desktop-monitor", title: "Mission Control", output: "stats-main", id: "dev.pocket-stack.stats", viewport: [480, 272], density: 2, framework: "solid", help: "Left / Right: switch panels" },
  { device: "3ds", title: "Contacts", output: "3ds-demo-main", id: "dev.pocket-stack.3ds-demo", viewport: [400, 240], auxiliary: [320, 240], density: 1, framework: "solid", help: "Tap a contact on the lower screen; drag to scroll" },
  { device: "psp", title: "Motion Lab", output: "motions-main", id: "dev.pocket-stack.motions", viewport: [480, 272], density: 1, framework: "solid", help: "Arrow keys: select; Enter: confirm" },
  { device: "vita", title: "Now Playing", output: "music-main", id: "dev.pocket-stack.music", viewport: [480, 272], density: 1, framework: "solid", help: "Q / E: change tracks; arrows and Enter: navigate" },
  { device: "ipod-touch-4", title: "Pocket Clear", output: "clear-main", artifact: "clear-main.vue-vapor", id: "dev.pocket-stack.clear", viewport: [320, 480], density: 1, framework: "vue-vapor", help: "Tap a list; swipe tasks left or right" },
  { device: "android-budget", title: "Pocket Note", output: "note-main", id: "dev.pocket-stack.note", viewport: [300, 500], density: 1, framework: "solid", help: "Up / Down or scroll wheel: read the sample note" },
] as const;
