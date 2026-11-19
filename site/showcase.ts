// Reviewed against the projects' public READMEs and PSPMAN's own site on
// 2026-09-05; 3DS entries refreshed on 2026-09-11, Pocket Shell on 2026-11-19.
// Links describe app support.
export type ShowcaseDevice = "3ds" | "psp" | "vita";
export const DEVICES: Record<ShowcaseDevice, string> = { "3ds": "Nintendo 3DS", psp: "PSP", vita: "PS Vita" };
export interface ShowcaseApp {
  id: string;
  name: string;
  category: string;
  devices: ShowcaseDevice[];
  description: string;
  image: string;
  imageAlt: string;
  imageCredit: string;
  imageSource: string;
  imageFit?: "contain";
  owner: string;
  community?: boolean;
  availability: string;
  requirement: string;
  action: string;
  href: string;
  source?: string;
  story?: string;
  steps: string[];
}
const gh = "https://github.com/pocket-nexus/";
export const SHOWCASE_APPS: ShowcaseApp[] = [
  {
    id: "openstrike", name: "OpenStrike", category: "Games", devices: ["psp", "vita"],
    description: "A CS-like FPS. Classic maps, bots, and a JSX heads-up display on a handheld.",
    image: "/assets/blog/openstrike-psp-dust2.png", imageAlt: "OpenStrike's Dust2 courtyard and game HUD, captured on PSP",
    imageCredit: "PSP capture · Pocket Nexus", imageSource: gh + "open-strike#readme", owner: "Pocket Nexus",
    availability: "Build from source", requirement: "Homebrew setup + game map assets", action: "Build & play", href: gh + "open-strike#building", source: gh + "open-strike",
    story: "/blog/shipping-openstrike/",
    steps: ["Choose the PSP or PS Vita build in the project guide.", "Prepare the map assets required by the game's cooker and build the app.", "Install the PSP EBOOT or PS Vita VPK using the platform instructions."],
  },
  {
    id: "pocket-doc", name: "Pocket Doc", category: "Productivity", devices: ["3ds"],
    description: "Your Markdown library on two screens. Read above, edit and navigate below.",
    image: "/assets/showcase/pocket-doc-3ds.png", imageAlt: "Pocket Doc's 3DS interface: a file list and rendered Markdown above two scrolling touchpads",
    imageCredit: "WASM interface capture · Pocket Nexus", imageSource: gh + "pocket-doc#screenshots", owner: "Pocket Nexus",
    imageFit: "contain",
    availability: "Build from source", requirement: "3DS Homebrew Launcher + paired Mac over Wi-Fi", action: "Set up on 3DS", href: gh + "pocket-doc#run", source: gh + "pocket-doc",
    steps: ["Clone the project with its runtime and install the 3DS build prerequisites.", "Build the app, then deploy its .3dsx and pairing key with ftpd.", "Start the Mac companion and open Pocket Doc from Homebrew Launcher."],
  },
  {
    id: "pocket-voxel", name: "Pocket Voxel", category: "Games", devices: ["psp", "vita"],
    description: "A Game Boy world rebuilt in voxels. Play in your browser or take it to a handheld.",
    image: "/assets/blog/voxel-psp-pallet-town.png", imageAlt: "Pocket Voxel's town with voxel houses, trees and a player, captured on PSP",
    imageCredit: "PSP capture · Pocket Nexus", imageSource: gh + "pocket-voxel#readme", owner: "Pocket Nexus",
    availability: "Web player + console export", requirement: "Bring your own supported US Pokémon Red ROM", action: "Open Web Player", href: "https://pocketvoxel.games/", source: gh + "pocket-voxel",
    story: "/blog/pocket-voxel/",
    steps: ["Open the Web Player and select your own supported ROM.", "The browser processes the ROM locally; you can play in the page.", "Choose PSP ZIP or PS Vita VPK to generate a console package. Console installation requires homebrew support."],
  },
  {
    id: "pspman", name: "PSPMAN", category: "Music", devices: ["psp"], community: true,
    description: "A Walkman-inspired music player. Local FLAC, MP3, album art, and cassette mode.",
    image: "/assets/showcase/pspman.png", imageAlt: "PSPMAN's Now Playing interface, from the official ObsoleteSony site",
    imageCredit: "Official product image · ObsoleteSony", imageSource: "https://www.obsoletesony.com/pspman", owner: "ObsoleteSony",
    availability: "Public alpha · source private", requirement: "Supported PSP + custom firmware; PSP-1000 unsupported", action: "Download public alpha", href: "https://www.obsoletesony.com/pspman", story: "https://www.obsoletesony.com/pspman/about",
    steps: ["Check the official compatibility list: PSP-2000, PSP-3000, PSP Street, or PSP Go with an M2 card. PSP Go internal storage is unsupported.", "Download the alpha and copy the complete PSPMAN folder to /PSP/GAME/ on the Memory Stick.", "Add your music to /MUSIC/ or /PSP/MUSIC/, then launch from Game → Memory Stick."],
  },
  {
    id: "pocket-shell", name: "Pocket Shell", category: "Launcher", devices: ["3ds", "psp"],
    description: "A launcher for Pocket Applets. Pair a 3DS or an M5Stack Tab5 with a Mac, install the applets it offers and switch between them; the PSP build runs the launcher alone.",
    image: "/assets/showcase/pocket-shell.png", imageAlt: "Pocket Shell's home screen on a 3DS: YouTube, Discord, Hacker News, Pocket Nexus and X above a dock of Settings, Camera, Photos and Mac on the touch screen, and Claude's room with an L+R Ask Claude hint on the top screen",
    imageCredit: "Old 3DS capture · Pocket Nexus", imageSource: gh + "pocket-shell/blob/main/shells/3ds/README.md", owner: "Pocket Nexus",
    imageFit: "contain",
    availability: "Build from source", requirement: "3DS Homebrew Launcher + ftpd; Bun, Docker and Rust to build", action: "Set up on 3DS", href: gh + "pocket-shell#development", source: gh + "pocket-shell",
    steps: ["Clone the project with its PocketJS submodule, run its setup and build the 3DS .3dsx.", "With ftpd running on the 3DS, copy the .3dsx to /3ds/ on the SD card and run the pair command once to write this computer's pairing onto the card.", "Serve the applets of a pocket-nexus/applets checkout with the offer command, open Pocket Shell in Homebrew Launcher and tap Mac on the home screen to install them. The README also covers the M5Stack Tab5 firmware and the PSP EBOOT."],
  },
  {
    id: "pocket-figma", name: "Pocket Figma", category: "Design", devices: ["psp", "vita"],
    description: "Explore a Figma file with a thumbstick. Pan and zoom through a baked design canvas.",
    image: "/assets/blog/figma-psp-components-zoom.png", imageAlt: "Pocket Figma's design component canvas and zoom controls in a PSP-sized framebuffer",
    imageCredit: "Emulator capture · Pocket Nexus", imageSource: gh + "pocket-figma#readme", owner: "Pocket Nexus",
    availability: "Build from source", requirement: "PSP or PS Vita homebrew setup", action: "Build the viewer", href: gh + "pocket-figma#build", source: gh + "pocket-figma", story: "/blog/pocket-figma/",
    steps: ["Set up the project and its pinned PocketJS toolchain.", "Use the PSP or Vita build command in the README.", "Install the EBOOT or VPK. The device browses baked design tiles; this is a file viewer, not a live Figma editor."],
  },
  {
    id: "pocket-youtube", name: "Pocket YouTube", category: "Video", devices: ["3ds", "psp", "vita"],
    description: "Watch above, search and browse below. A Mac companion streams video to the 3DS over Wi-Fi, with PSP and PS Vita builds too.",
    image: "/assets/showcase/pocket-youtube-3ds.png", imageAlt: "Pocket YouTube's 3DS interface replay: Big Buck Bunny above touch-screen search results",
    imageCredit: "WASM UI replay · Pocket Nexus · Big Buck Bunny © 2008 Blender Foundation, CC BY 3.0", imageSource: gh + "pocket-youtube/blob/main/docs/media/README.md", owner: "Pocket Nexus",
    imageFit: "contain",
    availability: "Build from source", requirement: "New 3DS with homebrew and DSP firmware + Mac companion on the same LAN", action: "Set up on 3DS", href: gh + "pocket-youtube/blob/main/docs/3DS.md", source: gh + "pocket-youtube", story: "/blog/pocket-youtube/",
    steps: ["Follow the 3DS guide to install the toolchain and prepare DSP firmware on a New 3DS.", "Build the app and deploy its .3dsx and pairing key with ftpd.", "Exit ftpd, open Pocket YouTube in Homebrew Launcher, and start the Mac companion with the console's IP address. The README also covers PSP over USB and PS Vita over Wi-Fi."],
  },
  {
    id: "pocket-map", name: "Pocket Map", category: "Maps", devices: ["3ds", "psp"],
    description: "Browse OpenStreetMap or Hyrule on a handheld. Pan with the touchpad, zoom, search and save places through a paired Mac.",
    image: "/assets/showcase/pocket-map-3ds.png", imageAlt: "Pocket Map's native 3DS build in Azahar: Union Square above the map touchpad and zoom controls",
    imageCredit: "Native 3DS capture in Azahar · Pocket Nexus · © OpenStreetMap contributors", imageSource: gh + "pocket-map#san-francisco-on-the-3ds-native-renderer", owner: "Pocket Nexus",
    imageFit: "contain",
    availability: "Build from source", requirement: "3DS Homebrew Launcher + paired Mac on the same LAN", action: "Set up on 3DS", href: gh + "pocket-map#try-it", source: gh + "pocket-map",
    steps: ["Clone the project with its runtime and install the 3DS build prerequisites.", "Follow the setup guide to prepare the map assets, build the app and deploy it through ftpd.", "Open Pocket Map in Homebrew Launcher and start the Mac companion with the console's IP address. The project also documents a PSP build over USB."],
  },
  {
    id: "pocket-term", name: "Pocket Term", category: "Tools", devices: ["3ds"],
    description: "A terminal in your hands. Mac shell sessions above a touch keyboard on the 3DS.",
    image: "/assets/showcase/pocket-term.png", imageAlt: "Pocket Term's native 3DS interface in Azahar: an 80-column terminal above session tabs, a touchpad and a keyboard",
    imageCredit: "Native 3DS capture in Azahar · Pocket Nexus", imageSource: gh + "pocket-term/blob/main/docs/screenshots/README.md", owner: "Pocket Nexus",
    imageFit: "contain",
    availability: "Build from source", requirement: "3DS homebrew setup + Mac companion", action: "Open setup guide", href: gh + "pocket-term#readme", source: gh + "pocket-term",
    steps: ["Follow the project's requirements for the Mac companion and 3DS build.", "Start the companion that hosts the terminal sessions on your Mac.", "Connect the 3DS app to browse sessions and send input with its touch keyboard."],
  },
];
