// site/templates.ts — the shared HTML shell (header, footer, <head>). Every
// page is renderPage(...)'d so nav/branding/theme stay in one place. Styling is
// Tailwind (utilities inline + a few component classes in assets/tailwind.css).

const YEAR = 2026;
const GH = "https://github.com/pocket-stack/pocketjs";
const DISCORD = "https://discord.gg/cTce4eXzSK";
const X_URL = "https://x.com/pocket_js";
export const SITE_URL = "https://pocketjs.dev";
export const SITE_TITLE = "PocketJS · JavaScript UI runtime";
export const SITE_DESC =
  "PocketJS is a portable application runtime that turns modern component code into native pixels across radically different hardware. Solid, Vue Vapor and Octane components compile to one native tree that a Rust core lays out and draws, with no DOM, CSS engine or WebView underneath.";
// Shared by the standalone homepage and every page rendered through renderPage().
export const SITE_FOOTER_DESC =
  "A portable application runtime that turns modern component code into native pixels, carried to radically different hardware by a compact native core.";
export const SITE_FOOTER_DESC_SLOT = "{{SITE_FOOTER_DESC}}";
export const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;

// Every icon a browser, a phone home screen or a Safari tab asks for. All of it
// is rendered from site/assets/favicon.svg by `bun tools/icons.ts`, so the three
// <head>s on this site (here, the homepage and the /for/ pages) share one list.
//
// iOS ignores the manifest when an apple-touch-icon exists and picks the link
// whose `sizes` is closest to the size it wants, so every rung of that ladder is
// declared: an iPhone asking for 180 must not settle for a scaled 152. ICON_V
// versions those URLs because iOS caches the home screen icon per URL and keeps
// serving a page screenshot if the first fetch ever came up empty; bump it when
// the drawing changes.
//
// Two of these entries exist for Safari specifically. The sizes-less
// apple-touch-icon is the form Apple documents, at the root name Safari looks
// for on its own, with no query on it: bookmarks and the Favorites grid read
// that path rather than the sized ladder the home screen picks from. And Safari
// could not render an SVG favicon until version 26, so a large PNG favicon has
// to be declared as well or every Safari before that has only the 96 to scale.
const ICON_V = "3";
export const ICON_LINKS = [
  `<link rel="icon" href="/favicon.svg?v=${ICON_V}" type="image/svg+xml">`,
  `<link rel="icon" href="/favicon.ico?v=${ICON_V}" sizes="48x48">`,
  `<link rel="icon" href="/favicon-96.png?v=${ICON_V}" type="image/png" sizes="96x96">`,
  `<link rel="icon" href="/icon-192.png?v=${ICON_V}" type="image/png" sizes="192x192">`,
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=${ICON_V}">`,
  `<link rel="apple-touch-icon" sizes="167x167" href="/apple-touch-icon-167.png?v=${ICON_V}">`,
  `<link rel="apple-touch-icon" sizes="152x152" href="/apple-touch-icon-152.png?v=${ICON_V}">`,
  `<link rel="apple-touch-icon" sizes="120x120" href="/apple-touch-icon-120.png?v=${ICON_V}">`,
  '<meta name="apple-mobile-web-app-title" content="PocketJS">',
  '<link rel="mask-icon" href="/safari-pinned-tab.svg" color="#ffd23f">',
  '<link rel="manifest" href="/site.webmanifest">',
].join("\n");

export function injectSiteFooterDescription(template: string): string {
  const slots = template.split(SITE_FOOTER_DESC_SLOT).length - 1;
  if (slots !== 1) {
    throw new Error(`Expected ${SITE_FOOTER_DESC_SLOT} exactly once in the homepage template; found ${slots}`);
  }
  return template.replace(SITE_FOOTER_DESC_SLOT, () => SITE_FOOTER_DESC);
}

export interface PageOpts {
  title: string | null; // null uses the bare wordmark (homepage)
  active: string; // "home" | "docs" | "playground" | "blog"
  body: string;
  bodyClass?: string;
  head?: string;
  scripts?: string[];
  path?: string;
  description?: string;
  robots?: string;
}

// The nav mark, drawn inline so the shared shell needs no extra request.
// Same geometry as site/assets/favicon.svg, which is the source of record.
export const LOGO = `<svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
  <rect x="2" y="6" width="28" height="20" rx="6" fill="none" stroke="#ffd23f" stroke-width="2.6" stroke-linejoin="round"/>
  <circle cx="10" cy="16" r="3.1" fill="#ff5f9e"/>
  <rect x="16" y="12.6" width="10" height="2.2" rx="1.1" fill="#3fd0e8"/>
  <rect x="16" y="17.2" width="6.5" height="2.2" rx="1.1" fill="#ff5f9e"/>
</svg>`;

function header(active: string): string {
  const ghIcon =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.6-.3-5.3-1.3-5.3-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17 4.7 18 5 18 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.5-2.7 5.5-5.3 5.8.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6 4.6-1.5 7.9-5.8 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/></svg>';
  const discordIcon =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19.54 5.34A17.75 17.75 0 0 0 15.07 4c-.19.35-.41.82-.56 1.19a16.5 16.5 0 0 0-5.02 0A12.1 12.1 0 0 0 8.92 4c-1.55.27-3.06.73-4.47 1.34C1.62 9.54.86 13.64 1.24 17.68A17.9 17.9 0 0 0 6.72 20.4c.44-.59.83-1.22 1.16-1.89-.64-.24-1.25-.54-1.83-.89.15-.11.3-.23.44-.35a12.68 12.68 0 0 0 11.02 0c.15.12.29.24.44.35-.58.35-1.2.65-1.84.89.34.67.72 1.3 1.16 1.89a17.85 17.85 0 0 0 5.49-2.72c.45-4.69-.75-8.75-3.22-12.34ZM8.7 15.19c-1.07 0-1.95-.98-1.95-2.18s.86-2.18 1.95-2.18c1.08 0 1.96.98 1.95 2.18 0 1.2-.87 2.18-1.95 2.18Zm6.6 0c-1.07 0-1.95-.98-1.95-2.18s.86-2.18 1.95-2.18c1.08 0 1.96.98 1.95 2.18 0 1.2-.87 2.18-1.95 2.18Z"/></svg>';
  const xIcon =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  const link = (href: string, label: string, key: string) =>
    `<a href="${href}" class="${active === key ? "on" : ""}">${label}</a>`;
  const ico = (href: string, label: string, svg: string) =>
    `<a class="ico" href="${href}" target="_blank" rel="noreferrer" aria-label="${label}">${svg}</a>`;
  return `<header class="nav">
  <div class="wrap">
    <a href="/" class="mark" aria-label="PocketJS home">
      ${LOGO}<span class="nm">PocketJS</span>
    </a>
    <nav class="nav-links" aria-label="Primary">
      ${link("/docs/overview/", "Docs", "docs")}
      ${link("/blog/", "Blog", "blog")}
      <div class="menu">
        <button class="menu-btn" aria-haspopup="true" aria-expanded="false">Resources
          <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="menu-list">
          <a href="/playground/">Playground</a>
          <a href="/changelog/">Changelog</a>
        </div>
      </div>
      ${ico(X_URL, "PocketJS on X", xIcon)}
      ${ico(GH, "PocketJS on GitHub", ghIcon)}
      ${ico(DISCORD, "PocketJS Discord", discordIcon)}
    </nav>
  </div>
</header>`;
}

const footer = `<footer class="foot">
  <div class="wrap">
    <span class="hud">© ${YEAR} PocketJS · MIT · a Pocket Lab project</span>
    <nav class="cols2" aria-label="Footer">
      <span class="fgrp">
        <a href="/docs/overview/">Docs</a>
        <a href="/playground/">Playground</a>
        <a href="/blog/">Blog</a>
        <a href="/changelog/">Changelog</a>
      </span>
      <span class="fgrp"><span class="fdot" aria-hidden="true">·</span>
        <a href="${GH}" target="_blank" rel="noreferrer">GitHub</a>
        <a href="${X_URL}" target="_blank" rel="noreferrer">X</a>
        <a href="${DISCORD}" target="_blank" rel="noreferrer">Discord</a>
      </span>
    </nav>
    <span class="hud">${SITE_FOOTER_DESC}</span>
  </div>
</footer>`;

export function renderPage(o: PageOpts): string {
  const fullTitle = o.title ? `${o.title} · PocketJS` : SITE_TITLE;
  const desc = o.description ?? SITE_DESC;
  const canonical = `${SITE_URL}${o.path ?? "/"}`;
  const robots = o.robots ?? "index,follow";
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareSourceCode",
    name: "PocketJS",
    description: SITE_DESC,
    url: SITE_URL,
    codeRepository: GH,
    programmingLanguage: ["TypeScript", "JavaScript", "Rust"],
    runtimePlatform: ["Sony PSP", "PPSSPP", "WebAssembly", "Bun"],
  });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${desc}">
<meta name="robots" content="${robots}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PocketJS">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${SITE_TITLE}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${fullTitle}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${OG_IMAGE_URL}">
<meta name="theme-color" content="#171226">
${ICON_LINKS}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=STIX+Two+Text:ital,wght@0,400;0,600;1,400&family=VT323&family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/assets/site.css">
<script type="application/ld+json">${jsonLd}</script>
${o.head ?? ""}
</head>
<body class="min-h-screen ${o.bodyClass ?? ""}">
${header(o.active)}
<main>${o.body}</main>
${footer}
${(o.scripts ?? []).join("\n")}
</body>
</html>`;
}
