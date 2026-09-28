// site/film.ts — the /mv/ page shell.
//
// Lives apart from build.ts so site/verify-mv.ts can render the real page and
// drive it in a browser without a full site build behind it.

import { ICON_LINKS, OG_IMAGE_URL, SITE_URL } from "./templates.ts";

// The film's ES modules, copied verbatim: they import each other by relative
// path and the page loads player.js as a module, so there is nothing to bundle.
// capture.html is the video renderer's harness and is not one of these.
export const FILM_MODULES = ["player.js", "film.js", "draw.js", "score.js", "lyrics.js", "audio-worker.js"];

export const FILM_TITLE = "A Sky in Your Pocket";
export const FILM_DESC =
  "An original short film for PocketJS: every frame drawn on a canvas as it plays, " +
  "every sample of the music synthesized in the browser.";

/**
 * The film page. It carries its own chrome (mv.css) and adds one Japanese
 * display face to the shared font request, because the lyric is set in Japanese.
 */
export function renderFilmPage(body: string): string {
  const url = `${SITE_URL}/mv/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${FILM_TITLE} · PocketJS</title>
<meta name="description" content="${FILM_DESC}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${FILM_TITLE} · PocketJS">
<meta property="og:description" content="${FILM_DESC}">
<meta property="og:type" content="video.other">
<meta property="og:site_name" content="PocketJS">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${OG_IMAGE_URL}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${FILM_TITLE} · PocketJS">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${FILM_TITLE} · PocketJS">
<meta name="twitter:description" content="${FILM_DESC}">
<meta name="twitter:image" content="${OG_IMAGE_URL}">
<meta name="theme-color" content="#171226">
${ICON_LINKS}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@700;900&family=IBM+Plex+Sans:wght@500;600;700&family=IBM+Plex+Mono:wght@500&family=VT323&display=swap">
<link rel="stylesheet" href="/mv/mv.css">
</head>
<body>
${body}
<script type="module" src="/mv/player.js"></script>
</body>
</html>`;
}
