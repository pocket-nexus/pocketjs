// apps/hn/api.ts — the Hacker News Firebase API over @pocketjs/framework/net.
//
// A feed is one id list (/v0/topstories.json); every story and comment is
// one more request (/v0/item/<id>.json). The NET module admits at most
// NET_MAX_INFLIGHT (2) requests at a time, so every request goes through one
// queue that starts the next as a slot frees. Comment fetches jump the queue
// ahead of story prefetches, so the thread on screen fills first. Items are
// kept in memory for the life of the app.

import { fetch, NetError } from "@pocketjs/framework/net";

export const API = "https://hacker-news.firebaseio.com/v0";
export const MAX_INFLIGHT = 2;

export type Feed = "top" | "new" | "best" | "ask" | "show";
export const FEEDS: readonly { id: Feed; label: string; path: string }[] = [
  { id: "top", label: "Top", path: "topstories" },
  { id: "new", label: "New", path: "newstories" },
  { id: "best", label: "Best", path: "beststories" },
  { id: "ask", label: "Ask", path: "askstories" },
  { id: "show", label: "Show", path: "showstories" },
];

export interface Item {
  id: number;
  type?: "story" | "comment" | "job" | "poll" | "pollopt";
  by?: string;
  time?: number;
  title?: string;
  url?: string;
  text?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  parent?: number;
  deleted?: boolean;
  dead?: boolean;
}

/** A failed request, with the NET error code when there is one. */
export class HnError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface Task {
  url: string;
  resolve: (value: unknown) => void;
  reject: (error: HnError) => void;
}

export interface HnClient {
  feed(feed: Feed): Promise<number[]>;
  item(id: number, urgent?: boolean): Promise<Item | null>;
  cached(id: number): Item | undefined;
  /** Requests in flight (for tests: never above MAX_INFLIGHT). */
  inflight(): number;
  /** Highest inflight count seen. */
  peak(): number;
}

export function createHnClient(): HnClient {
  const items = new Map<number, Item>();
  const pendingItems = new Map<number, Promise<Item | null>>();
  const queue: Task[] = [];
  let running = 0;
  let peak = 0;

  const pump = () => {
    while (running < MAX_INFLIGHT && queue.length > 0) {
      const task = queue.shift()!;
      running++;
      peak = Math.max(peak, running);
      fetch(task.url, { timeoutMs: 20_000, maxBytes: 256 * 1024 }).then(
        async (response) => {
          running--;
          pump();
          if (!response.ok) {
            task.reject(new HnError("http", `HTTP ${response.status}`));
            return;
          }
          try {
            task.resolve(await response.json());
          } catch {
            task.reject(new HnError("protocol", "The response was not JSON."));
          }
        },
        (error: unknown) => {
          running--;
          pump();
          const code = error instanceof NetError ? error.code : "other";
          task.reject(new HnError(code, error instanceof Error ? error.message : String(error)));
        },
      );
    }
  };

  const request = <T,>(url: string, urgent: boolean): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const task: Task = { url, resolve: resolve as (value: unknown) => void, reject };
      if (urgent) queue.unshift(task);
      else queue.push(task);
      pump();
    });

  return {
    feed(feed) {
      const path = FEEDS.find((entry) => entry.id === feed)!.path;
      return request<number[]>(`${API}/${path}.json`, true).then((ids) => (Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id)) : []));
    },
    item(id, urgent = false) {
      const have = items.get(id);
      if (have) return Promise.resolve(have);
      const inFlight = pendingItems.get(id);
      if (inFlight) return inFlight;
      const promise = request<Item | null>(`${API}/item/${id}.json`, urgent).then(
        (item) => {
          pendingItems.delete(id);
          if (item && typeof item === "object") items.set(id, item);
          return item ?? null;
        },
        (error: HnError) => {
          pendingItems.delete(id);
          throw error;
        },
      );
      pendingItems.set(id, promise);
      return promise;
    },
    cached: (id) => items.get(id),
    inflight: () => running,
    peak: () => peak,
  };
}

/** The message a reader sees for a failed request. */
export function errorText(error: unknown): { title: string; detail: string } {
  const code = error instanceof HnError ? error.code : "";
  if (code === "unavailable") {
    return { title: "Not linked to a Mac", detail: "Hacker News loads through your Mac. Pair one in Settings > Mac and open Pocket Companion." };
  }
  if (code === "timeout") return { title: "The request timed out", detail: "The Mac or the network did not answer in time." };
  const message = error instanceof Error ? error.message : String(error);
  return { title: "Could not load", detail: message || "The request failed." };
}
