// tests/hn-fixture.ts — a deterministic Hacker News for the HN sim tests:
// feeds, stories and a comment thread as NET routes (hosts/sim/net.ts).
// Every title, name and comment is invented for the fixture.

import type { SimNetRoute } from "../hosts/sim/net.ts";

export const HN_API = "https://hacker-news.firebaseio.com/v0";
/** 2026-10-19T01:41:00Z, the console sim's default boot epoch. */
export const HN_NOW = Math.floor(Date.UTC(2026, 9, 19, 1, 41, 0) / 1000);

const TITLES = [
  "Show HN: A dual-screen Hacker News reader for the Nintendo 3DS",
  "The quiet engineering behind resistive touch screens",
  "Writing a QuickJS host in 4,000 lines of C",
  "Ask HN: What is your favorite small computer?",
  "PICA200: a tour of the 3DS GPU",
  "Why we moved our build cache to SQLite",
  "A field guide to font atlases",
  "Rust on ARMv6K without an operating system",
  "The economics of e-ink displays",
  "Show HN: I built a QR pairing flow for a handheld",
  "How TCP keepalives actually behave on consumer routers",
  "Notes on designing for 240 pixels of height",
];
const AUTHORS = ["ruthk", "pocketdev", "lmoreno", "thehinge", "dpadfan", "kestrel", "nbaker", "s_ito"];

export interface HnFixtureItem {
  id: number;
  type: string;
  by?: string;
  time: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  parent?: number;
  deleted?: boolean;
}

export function hnFixture(options: { stories?: number } = {}): { items: Map<number, HnFixtureItem>; top: number[] } {
  const count = options.stories ?? 45;
  const items = new Map<number, HnFixtureItem>();
  const top: number[] = [];
  for (let index = 0; index < count; index++) {
    const id = 1001 + index;
    top.push(id);
    const title = TITLES[index % TITLES.length]! + (index >= TITLES.length ? ` (${Math.floor(index / TITLES.length) + 1})` : "");
    const ask = title.startsWith("Ask HN");
    items.set(id, {
      id,
      type: "story",
      by: AUTHORS[index % AUTHORS.length],
      time: HN_NOW - (index + 1) * 2700,
      title,
      url: ask ? undefined : `https://www.example${index % 5}.com/posts/${id}`,
      text: ask ? "<p>Mine is a 3DS running PocketJS. I&#x27;d love to hear about yours &amp; why.</p>" : undefined,
      score: 400 - index * 7,
      descendants: index === 0 ? 7 : (index * 13) % 90,
      kids: [],
    });
  }
  // The first story's thread: two top-level comments, nested replies, a deleted leaf.
  const thread: HnFixtureItem[] = [
    { id: 5001, type: "comment", by: "ruthk", time: HN_NOW - 2000, parent: 1001, kids: [5003, 5004],
      text: "This is great. The top screen as a reading pane is exactly right &#x2014; it&#x27;s how the hardware wants to be used.<p>Does it cache stories between launches?" },
    { id: 5002, type: "comment", by: "kestrel", time: HN_NOW - 1800, parent: 1001, kids: [5006],
      text: "How does it reach the API? The 3DS TLS stack can&#x27;t talk to modern servers: <a href=\"https://example.com/tls\" rel=\"nofollow\">https://example.com/tls</a>" },
    { id: 5003, type: "comment", by: "pocketdev", time: HN_NOW - 1500, parent: 5001, kids: [5005],
      text: "Not yet. Items live in memory while the app runs; <i>Home</i> relaunches apps on every switch, so the cache starts empty." },
    { id: 5004, type: "comment", time: HN_NOW - 1400, parent: 5001, deleted: true },
    { id: 5005, type: "comment", by: "ruthk", time: HN_NOW - 1200, parent: 5003, kids: [],
      text: "Makes sense. &quot;Relaunch is resume&quot; keeps it simple." },
    { id: 5006, type: "comment", by: "pocketdev", time: HN_NOW - 1000, parent: 5002, kids: [5007],
      text: "Through the paired Mac. The console sends the request over the Pocket Link and the Mac performs it with its own TLS.<p><pre><code>  fetch(url) -&gt; link -&gt; Mac -&gt; https\n</code></pre>" },
    { id: 5007, type: "comment", by: "thehinge", time: HN_NOW - 600, parent: 5006, kids: [],
      text: "Clever. Same trick as the old WAP gateways." },
  ];
  for (const comment of thread) items.set(comment.id, comment);
  items.get(1001)!.kids = [5001, 5002];
  return { items, top };
}

/** NET routes serving the fixture; `failFeeds` answers every feed with `code`. */
export function hnRoutes(options: { stories?: number; failFeeds?: string } = {}): Record<string, SimNetRoute> {
  const { items, top } = hnFixture(options);
  const routes: Record<string, SimNetRoute> = {};
  for (const feed of ["topstories", "newstories", "beststories", "askstories", "showstories"]) {
    const ids = feed === "topstories" ? top : feed === "askstories" ? top.filter((id) => items.get(id)!.title!.startsWith("Ask HN")) : [...top].reverse();
    routes[`${HN_API}/${feed}.json`] = options.failFeeds
      ? { error: { code: options.failFeeds, message: "net: the Pocket Link is not connected" } }
      : { body: JSON.stringify(ids), delayTicks: 3 };
  }
  for (const [id, item] of items) routes[`${HN_API}/item/${id}.json`] = { body: JSON.stringify(item), delayTicks: 2 };
  return routes;
}
