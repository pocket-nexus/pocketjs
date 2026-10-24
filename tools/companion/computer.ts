// The computer the companion runs on, as service messages name it: a Mac, or
// a Linux machine such as a CardputerZero serving a PSP's share. A leaf
// module: services.ts and the services it registers both import it.

export const COMPUTER = process.platform === "darwin" ? "Mac" : "computer";

/** How this computer installs yt-dlp and ffmpeg. */
export const INSTALL_MEDIA_TOOLS =
  process.platform === "darwin" ? "brew install yt-dlp ffmpeg" : "apt install ffmpeg, and yt-dlp from github.com/yt-dlp/yt-dlp/releases";
