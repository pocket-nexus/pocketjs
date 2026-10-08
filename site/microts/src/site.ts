// Site constants: external links and the Pocket family nav.

export const GITHUB_POCKETJS = "https://github.com/pocket-nexus/pocketjs";
export const GITHUB_MICROTS = "https://github.com/pocket-nexus/pocketjs/tree/main/microts";
export const GITHUB_RETRO = "https://github.com/pocket-nexus/pocket-retro";
export const POCKETJS_SITE = "https://pocketjs.pocket.nexus";
export const NEXUS_SITE = "https://pocket.nexus";

// Icons match the Technology menu on pocket.nexus
const ICON_POCKETJS = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="6" width="28" height="20" rx="6" fill="#171226" stroke="#ffd23f" stroke-width="2.6"/><circle cx="10" cy="16" r="3.1" fill="#ff5f9e"/><rect x="16" y="12.6" width="10" height="2.2" rx="1.1" fill="#3fd0e8"/><rect x="16" y="17.2" width="6.5" height="2.2" rx="1.1" fill="#ff5f9e"/></svg>`;
const ICON_NEXUS = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><path d="M5 13h22v7.4c0 1-.3 1.9-.9 2.6C23.6 26 20 27.8 16 27.8S8.4 26 5.9 23C5.3 22.3 5 21.4 5 20.4z" fill="#171226" stroke="#ffd23f" stroke-width="2.6" stroke-linejoin="round"/><path d="M9 17.4h14" stroke="#ffd23f" stroke-width="1.4" stroke-linecap="round" stroke-dasharray="2.2 2.2"/><path d="M16 1.6c.55 3.4 1.5 4.5 4.9 5.05-3.4.55-4.35 1.65-4.9 5.05-.55-3.4-1.5-4.5-4.9-5.05 3.4-.55 4.35-1.65 4.9-5.05z" fill="#ff5f9e"/><circle cx="24.2" cy="5" r="1.8" fill="#3fd0e8"/></svg>`;
const ICON_3D = `<img src="/pocket3d-mark.svg" width="26" height="26" alt="">`;
const ICON_STUDIO = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x="4" y="5" width="24" height="22" rx="6" fill="#171226" stroke="#ffd23f" stroke-width="2.6"/><path d="M10 20.5 14.5 12l3.5 6 2-3 2.5 5.5" fill="none" stroke="#3fd0e8" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11" cy="11" r="2" fill="#ff5f9e"/></svg>`;
export const ICON_RETRO = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="8" width="28" height="17" rx="6.5" fill="#171226" stroke="#ffd23f" stroke-width="2.4"/><rect x="10" y="11.5" width="12" height="9.5" rx="1.5" fill="#2b335f" stroke="#a98bff" stroke-width="1.4"/><path d="M5.6 16.5h3M7.1 15v3" stroke="#3fd0e8" stroke-width="1.6" stroke-linecap="round"/><circle cx="25.2" cy="15.2" r="1.3" fill="#ff5f9e"/><circle cx="23.4" cy="18" r="1.3" fill="#ff5f9e"/></svg>`;

export const FAMILY = [
  { name: "Pocket Nexus", tagline: "The lab behind the Pocket family", href: NEXUS_SITE, icon: ICON_NEXUS },
  { name: "PocketJS", tagline: "Create UI on every screen you love", href: POCKETJS_SITE, icon: ICON_POCKETJS },
  { name: "Pocket3D", tagline: "Create 3D for every machine you love", href: "https://3d.pocket.nexus", icon: ICON_3D },
  { name: "Pocket Studio", tagline: "Make a game with your coding agent", href: "https://studio.pocket.nexus", icon: ICON_STUDIO },
  { name: "Pocket Retro", tagline: "Pyxel games compiled for the Game Boy Advance", href: GITHUB_RETRO, icon: ICON_RETRO },
];
