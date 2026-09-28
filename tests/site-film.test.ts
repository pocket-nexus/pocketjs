// tests/site-film.test.ts — the /mv/ film's two source of truth files.
//
// site/mv/score.js and site/mv/film.js are the whole film: the page plays them
// against the audio clock and tools/render-mv.ts renders a video out of them by
// stepping time by hand. That only works while the song is deterministic and
// the words sit on the bars the picture cuts on, so both are pinned here.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { BAR, BARS, BAR_CHORDS, DURATION, LEAD, SECTIONS, renderSong } from "../site/mv/score.js";
import { LYRICS, lyricAt } from "../site/mv/lyrics.js";
import { FILM_MODULES, FILM_TITLE, renderFilmPage } from "../site/film.ts";

const ROOT = new URL("..", import.meta.url).pathname;

describe("the film's score", () => {
  test("names a chord for every bar of the song", () => {
    expect(BAR_CHORDS).toHaveLength(BARS);
    expect(new Set(BAR_CHORDS)).toEqual(new Set(["Am", "F", "C", "G", "Em"]));
    expect(DURATION).toBeCloseTo(BARS * BAR, 6);
  });

  test("the sections tile the song end to end with no gap", () => {
    const spans = Object.values(SECTIONS).sort((a, b) => a.from - b.from);
    expect(spans[0].from).toBe(0);
    expect(spans[spans.length - 1].to).toBe(BARS);
    for (let i = 1; i < spans.length; i++) expect(spans[i].from).toBe(spans[i - 1].to);
  });

  test("every melody note lands inside the song", () => {
    expect(LEAD.length).toBeGreaterThan(120);
    for (const note of LEAD) {
      expect(note.beat).toBeGreaterThanOrEqual(0);
      expect(note.beat + note.dur).toBeLessThanOrEqual(BARS * 4 + 0.001);
      expect(note.note).toBeGreaterThan(40); // nothing below the bass register
      expect(note.note).toBeLessThan(100);
    }
  });

  test("renders the same samples twice — the video's audio is the page's audio", () => {
    // 8 kHz keeps the test quick; determinism does not depend on the rate.
    const a = renderSong(8000);
    const b = renderSong(8000);
    expect(a.length).toBe(b.length);
    let drift = 0;
    for (let i = 0; i < a.length; i++) drift = Math.max(drift, Math.abs(a.left[i] - b.left[i]), Math.abs(a.right[i] - b.right[i]));
    expect(drift).toBe(0);
  });

  test("leaves headroom and never goes non-finite", () => {
    const song = renderSong(8000);
    let peak = 0;
    let energy = 0;
    for (let i = 0; i < song.length; i++) {
      const l = song.left[i];
      const r = song.right[i];
      expect(Number.isFinite(l) && Number.isFinite(r)).toBe(true);
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
      energy += l * l + r * r;
    }
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThanOrEqual(0.95);
    expect(Math.sqrt(energy / (2 * song.length))).toBeGreaterThan(0.05); // not silence
  });

  test("the song fades out before the picture does", () => {
    const song = renderSong(8000);
    let tail = 0;
    for (let i = Math.floor((DURATION + 2) * 8000); i < song.length; i++) {
      tail = Math.max(tail, Math.abs(song.left[i]), Math.abs(song.right[i]));
    }
    expect(tail).toBeLessThan(0.08);
  });
});

describe("the film's lyric", () => {
  test("every line sits on a bar of the song and none overlap", () => {
    const sorted = [...LYRICS].sort((a, b) => a.bar - b.bar);
    expect(sorted).toEqual(LYRICS); // written in order
    let previousEnd = 0;
    for (const line of LYRICS) {
      expect(Number.isInteger(line.bar)).toBe(true);
      expect(line.bar).toBeGreaterThanOrEqual(previousEnd);
      expect(line.bar + line.bars).toBeLessThanOrEqual(BARS);
      expect(line.ja.length).toBeGreaterThan(0);
      expect(line.en.length).toBeGreaterThan(0);
      previousEnd = line.bar + line.bars;
    }
  });

  test("the chorus is the part that gets set large", () => {
    for (const line of LYRICS) {
      const inChorus = line.bar >= SECTIONS.chorus.from && line.bar < SECTIONS.chorus.to;
      expect(Boolean(line.slam)).toBe(inChorus);
    }
  });

  test("lyricAt reads the line the picture is cutting to", () => {
    expect(lyricAt(0)).toBeNull(); // the intro carries the title, not a lyric
    expect(lyricAt(8)?.bar).toBe(8);
    expect(lyricAt(9.9)?.bar).toBe(8);
    expect(lyricAt(10)?.bar).toBe(10);
    expect(lyricAt(BARS - 1)).toBeNull(); // the last bars are the wordmark
  });
});

describe("the film's page", () => {
  test("every module the page loads is on disk", () => {
    expect(FILM_MODULES).toContain("player.js");
    for (const module of FILM_MODULES) {
      expect(existsSync(`${ROOT}site/mv/${module}`)).toBe(true);
    }
    expect(existsSync(`${ROOT}site/mv/mv.css`)).toBe(true);
    expect(existsSync(`${ROOT}site/mv/page.html`)).toBe(true);
  });

  test("renders the body it is given, with the film's own head", () => {
    const html = renderFilmPage("<main>BODY MARKER</main>");
    expect(html).toContain("BODY MARKER");
    expect(html).toContain(FILM_TITLE);
    expect(html).toContain('<link rel="canonical" href="https://pocketjs.dev/mv/">');
    expect(html).toContain('<script type="module" src="/mv/player.js"></script>');
    expect(html).toContain("Zen+Kaku+Gothic+New"); // the lyric is set in Japanese
  });
});
