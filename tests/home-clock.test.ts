// tests/home-clock.test.ts — Pocket Home's clock arithmetic (apps/home/clock.ts):
// civil fields from Date.now() with a fixed UTC offset, never from Date's own
// local-time breakdown (broken on the 3DS host's QuickJS).

import { describe, expect, test } from "bun:test";
import {
  civilFromDays,
  civilFromEpoch,
  clockText,
  dateText,
  offsetText,
  statusTime,
  TIME_ZONES,
} from "../apps/home/clock.ts";

describe("civilFromEpoch", () => {
  test("matches Date's UTC fields for every offset across eras", () => {
    const offsets = [-600, -330, -60, 0, 60, 330, 480, 540, 720];
    // Leap days, a century that is not a leap year, the epoch, before it.
    const anchors = [
      Date.UTC(1969, 11, 31, 23, 59),
      Date.UTC(1970, 0, 1, 0, 0),
      Date.UTC(2000, 1, 29, 12, 30),
      Date.UTC(2100, 1, 28, 23, 59),
      Date.UTC(2024, 1, 29, 0, 0),
      Date.UTC(2026, 9, 19, 1, 41),
    ];
    for (const anchor of anchors) {
      for (let step = 0; step < 50; step++) {
        const epoch = anchor + step * 97 * 60_000;
        for (const offset of offsets) {
          const ours = civilFromEpoch(epoch, offset);
          const shifted = new Date(epoch + offset * 60_000);
          expect([ours.year, ours.month, ours.day, ours.hour, ours.minute, ours.weekday]).toEqual([
            shifted.getUTCFullYear(),
            shifted.getUTCMonth() + 1,
            shifted.getUTCDate(),
            shifted.getUTCHours(),
            shifted.getUTCMinutes(),
            shifted.getUTCDay(),
          ]);
        }
      }
    }
  });

  test("days to civil is exact over four centuries", () => {
    for (let days = -146097; days <= 146097 * 2; days += 37) {
      const date = new Date(days * 86_400_000);
      expect(civilFromDays(days)).toEqual({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
    }
  });
});

describe("clock text", () => {
  const morning = civilFromEpoch(Date.UTC(2026, 9, 19, 1, 41), 480);
  test("lock screen, status bar and date", () => {
    expect(clockText(morning)).toBe("9:41");
    expect(statusTime(morning)).toBe("9:41 AM");
    expect(dateText(morning)).toBe("Monday, October 19");
  });

  test("midnight and noon read 12", () => {
    expect(statusTime(civilFromEpoch(Date.UTC(2026, 0, 1, 0, 5), 0))).toBe("12:05 AM");
    expect(statusTime(civilFromEpoch(Date.UTC(2026, 0, 1, 12, 0), 0))).toBe("12:00 PM");
  });

  test("a negative offset crosses into the previous day", () => {
    const evening = civilFromEpoch(Date.UTC(2026, 9, 19, 1, 41), -300);
    expect(statusTime(evening)).toBe("8:41 PM");
    expect(dateText(evening)).toBe("Sunday, October 18");
  });

  test("offsets", () => {
    expect(offsetText(0)).toBe("UTC");
    expect(offsetText(480)).toBe("UTC+8");
    expect(offsetText(-300)).toBe("UTC-5");
    expect(offsetText(330)).toBe("UTC+5:30");
    expect(new Set(TIME_ZONES.map((zone) => zone.offset)).size).toBe(TIME_ZONES.length);
    expect(TIME_ZONES.some((zone) => zone.offset === 480)).toBe(true);
  });
});
