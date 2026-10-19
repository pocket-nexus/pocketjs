// apps/hn/model.ts — feeds, pages of stories and comment threads as
// signals over the API client.
//
// Stories load 20 at a time in feed order. A thread loads depth-first: the
// story's first kids, then each comment's kids ahead of its later siblings,
// at most two requests outstanding and at most MAX_COMMENTS per story, so a
// 900-comment thread costs a bounded number of round trips through the Mac.

import { createSignal, type Accessor } from "solid-js";
import { createHnClient, errorText, type Feed, type HnClient, type Item } from "./api.ts";

export const PAGE = 20;
export const MAX_COMMENTS = 60;
export const MAX_DEPTH = 6;
const THREAD_INFLIGHT = 2;

export interface FeedState {
  status: "loading" | "ready" | "error";
  ids: number[];
  /** Ids requested so far (a multiple of PAGE). */
  shown: number;
  error: { title: string; detail: string } | null;
}

export interface CommentNode {
  item: Item;
  depth: number;
}

export interface ThreadState {
  story: number;
  /** Comments fetched, by id. */
  nodes: Map<number, CommentNode>;
  requested: number;
  pending: number;
  error: { title: string; detail: string } | null;
  collapsed: Set<number>;
}

export interface HnModel {
  client: HnClient;
  feed: Accessor<Feed>;
  setFeed(feed: Feed): void;
  state: Accessor<FeedState>;
  /** Bumped whenever an item lands in the cache. */
  version: Accessor<number>;
  reload(): void;
  more(): void;
  thread: Accessor<ThreadState | null>;
  openThread(story: number): void;
  closeThread(): void;
  toggle(comment: number): void;
}

const EMPTY: FeedState = { status: "loading", ids: [], shown: 0, error: null };

export function createHnModel(client: HnClient = createHnClient()): HnModel {
  const [feed, setFeedSignal] = createSignal<Feed>("top");
  const [states, setStates] = createSignal<Partial<Record<Feed, FeedState>>>({});
  const [version, setVersion] = createSignal(0);
  const [thread, setThread] = createSignal<ThreadState | null>(null, { equals: false });
  const bump = () => setVersion(version() + 1);
  const put = (which: Feed, state: FeedState) => setStates({ ...states(), [which]: state });
  const generation: Partial<Record<Feed, number>> = {};

  const loadPage = (which: Feed, from: number) => {
    const state = states()[which];
    if (!state) return;
    for (const id of state.ids.slice(from, from + PAGE)) {
      client.item(id).then(bump, () => bump());
    }
  };

  const load = (which: Feed) => {
    const run = (generation[which] = (generation[which] ?? 0) + 1);
    put(which, { ...EMPTY });
    client.feed(which).then(
      (ids) => {
        if (generation[which] !== run) return;
        put(which, { status: "ready", ids, shown: Math.min(PAGE, ids.length), error: null });
        loadPage(which, 0);
      },
      (error: unknown) => {
        if (generation[which] !== run) return;
        put(which, { status: "error", ids: [], shown: 0, error: errorText(error) });
      },
    );
  };

  // ---- threads ------------------------------------------------------------------

  let queue: { id: number; depth: number }[] = [];
  let threadRun = 0;

  const pumpThread = () => {
    const current = thread();
    if (!current) return;
    while (current.pending < THREAD_INFLIGHT && queue.length > 0 && current.requested < MAX_COMMENTS) {
      const next = queue.shift()!;
      current.pending++;
      current.requested++;
      const run = threadRun;
      client.item(next.id, true).then(
        (item) => {
          if (run !== threadRun) return;
          current.pending--;
          if (item) {
            current.nodes.set(item.id, { item, depth: next.depth });
            // Depth-first: this comment's replies before its later siblings.
            if (item.kids?.length && next.depth + 1 < MAX_DEPTH) {
              queue = [...item.kids.map((id) => ({ id, depth: next.depth + 1 })), ...queue];
            }
          }
          setThread(current);
          pumpThread();
        },
        (error: unknown) => {
          if (run !== threadRun) return;
          current.pending--;
          current.error = errorText(error);
          setThread(current);
          pumpThread();
        },
      );
    }
    setThread(current);
  };

  return {
    client,
    feed,
    setFeed(next) {
      setFeedSignal(next);
      const state = states()[next];
      if (!state || state.status === "error") load(next);
    },
    state: () => states()[feed()] ?? EMPTY,
    version,
    reload: () => load(feed()),
    more() {
      const which = feed();
      const state = states()[which];
      if (!state || state.status !== "ready" || state.shown >= state.ids.length) return;
      const from = state.shown;
      put(which, { ...state, shown: Math.min(state.ids.length, state.shown + PAGE) });
      loadPage(which, from);
    },
    thread,
    openThread(story) {
      threadRun++;
      const item = client.cached(story);
      queue = (item?.kids ?? []).map((id) => ({ id, depth: 0 }));
      setThread({ story, nodes: new Map(), requested: 0, pending: 0, error: null, collapsed: new Set() });
      pumpThread();
    },
    closeThread() {
      threadRun++;
      queue = [];
      setThread(null);
    },
    toggle(comment) {
      const current = thread();
      if (!current) return;
      if (current.collapsed.has(comment)) current.collapsed.delete(comment);
      else current.collapsed.add(comment);
      setThread(current);
    },
  };
}

export interface FlatComment {
  id: number;
  depth: number;
  item: Item;
  /** Loaded replies hidden under a collapsed comment. */
  hidden: number;
}

/** The thread in reading order: loaded comments depth-first, skipping
 *  deleted or dead leaves and the replies of collapsed comments. */
export function flattenThread(story: Item | undefined, thread: ThreadState): FlatComment[] {
  const out: FlatComment[] = [];
  // A deleted or dead comment with no loaded replies is not shown, so it is not counted.
  const shown = (id: number): boolean => {
    const node = thread.nodes.get(id);
    if (!node) return false;
    return !(node.item.deleted || node.item.dead) || (node.item.kids ?? []).some((kid) => thread.nodes.has(kid));
  };
  const count = (id: number): number =>
    (thread.nodes.get(id)?.item.kids ?? []).reduce((sum, kid) => sum + (shown(kid) ? 1 + count(kid) : 0), 0);
  const visit = (ids: readonly number[] | undefined) => {
    for (const id of ids ?? []) {
      const node = thread.nodes.get(id);
      if (!node || !shown(id)) continue;
      const collapsed = thread.collapsed.has(id);
      out.push({ id, depth: node.depth, item: node.item, hidden: collapsed ? count(id) : 0 });
      if (!collapsed) visit(node.item.kids);
    }
  };
  visit(story?.kids);
  return out;
}
