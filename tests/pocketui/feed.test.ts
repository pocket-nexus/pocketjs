import { describe, expect, test } from "bun:test";
import { FeedModel } from "../../framework/src/pocketui/core/feed.ts";

const keys = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `k${from + i}`);

function filled(count: number, height = 50, viewport = 200): FeedModel {
  const feed = new FeedModel({ estimate: 50 });
  feed.setViewport(viewport);
  feed.setKeys(keys(0, count));
  for (const key of keys(0, count)) feed.setHeight(key, height);
  return feed;
}

/** where a row's top edge is on screen */
const screenTop = (feed: FeedModel, key: string) => feed.topOf(feed.indexOf(key)) - feed.scrollTop;

describe("follow", () => {
  test("a new feed is at its end and stays there as rows arrive and grow", () => {
    const feed = filled(10);
    expect(feed.scrollTop).toBe(300);
    feed.setKeys(keys(0, 12));
    feed.setHeight("k10", 50);
    feed.setHeight("k11", 50);
    expect(feed.scrollTop).toBe(400);
    feed.setHeight("k11", 180); // the last row streams
    expect(feed.scrollTop).toBe(530);
    expect(feed.atEnd()).toBe(true);
  });
  test("scrolling up leaves follow; reaching the end re-enters it", () => {
    const feed = filled(10);
    feed.scrollTo(120);
    expect(feed.following).toBe(false);
    feed.setKeys(keys(0, 11));
    feed.setHeight("k10", 50);
    expect(feed.scrollTop).toBe(120);
    feed.scrollTo(9999);
    expect(feed.following).toBe(true);
    feed.setHeight("k10", 90);
    expect(feed.atEnd()).toBe(true);
  });
  test("content shorter than the window sits at 0", () => {
    const feed = filled(2);
    expect(feed.scrollTop).toBe(0);
    expect(feed.max()).toBe(0);
  });
});

describe("the anchor", () => {
  test("rows added above do not move what is on screen", () => {
    const feed = filled(10);
    feed.scrollTo(130); // k2 is the anchor, 30 into it
    const before = screenTop(feed, "k4");
    const moved = feed.setKeys([...keys(-5, 0), ...keys(0, 10)]);
    for (const key of keys(-5, 0)) feed.setHeight(key, 50);
    expect(screenTop(feed, "k4")).toBe(before);
    expect(moved).toBe(250);
  });
  test("an estimate corrected above the anchor is absorbed", () => {
    const feed = new FeedModel({ estimate: 50 });
    feed.setViewport(200);
    feed.setKeys(keys(0, 20));
    for (const key of keys(10, 20)) feed.setHeight(key, 50);
    feed.scrollTo(560); // anchored in k11
    const before = screenTop(feed, "k12");
    feed.setHeight("k3", 140); // a row above turns out taller
    feed.setHeight("k4", 20); // and one shorter
    expect(screenTop(feed, "k12")).toBe(before);
  });
  test("a row below the anchor growing moves nothing on screen", () => {
    const feed = filled(10);
    feed.scrollTo(100);
    feed.setHeight("k8", 300);
    expect(feed.scrollTop).toBe(100);
  });
  test("the anchor row removed hands over to its neighbour", () => {
    const feed = filled(10);
    feed.scrollTo(130);
    feed.setKeys(keys(0, 10).filter((key) => key !== "k2"));
    expect(screenTop(feed, "k3")).toBe(0);
  });
  test("kept and restored across a remount", () => {
    const feed = filled(30);
    feed.scrollTo(730);
    const kept = feed.anchor();
    expect(kept).toEqual({ key: "k14", offset: 30 });
    const next = new FeedModel({ estimate: 50 });
    next.setViewport(260);
    next.setKeys(keys(0, 30));
    next.restore(kept);
    expect(screenTop(next, "k14")).toBe(-30);
    expect(filled(5).anchor()).toBe(null);
  });
});

describe("the window", () => {
  test("names the rows in view, widened by overscan", () => {
    const feed = filled(100);
    feed.scrollTo(1000);
    expect(feed.window(0)).toEqual([20, 24]);
    expect(feed.window(100)).toEqual([18, 26]);
  });
  test("gaps and padding are part of the layout", () => {
    const feed = new FeedModel({ estimate: 40, gap: 10, padStart: 8, padEnd: 12 });
    feed.setViewport(100);
    feed.setKeys(keys(0, 4));
    expect(feed.total()).toBe(8 + 4 * 40 + 3 * 10 + 12);
    expect(feed.topOf(2)).toBe(108);
  });
  test("an empty feed", () => {
    const feed = new FeedModel();
    feed.setViewport(100);
    expect(feed.window(50)).toBe(null);
    expect(feed.total()).toBe(0);
    feed.scrollTo(40);
    expect(feed.scrollTop).toBe(0);
  });
  test("scrollToKey", () => {
    const feed = filled(40);
    feed.scrollToKey("k10");
    expect(feed.scrollTop).toBe(500);
    feed.scrollToKey("k10", "nearest");
    expect(feed.scrollTop).toBe(500);
    feed.scrollToKey("k20", "nearest", 6);
    expect(feed.scrollTop).toBe(1050 + 6 - 200);
  });
});
