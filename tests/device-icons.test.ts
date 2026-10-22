import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryPath = (...parts: string[]) => resolve(import.meta.dir, "..", ...parts);

test("modern iPod and classic iPhone preserve their selected palettes and common mark geometry", () => {
  const modern = readFileSync(repositoryPath("programs/ipodtouch6/Icon.svg"), "utf8");
  expect(modern).toContain('rx="6" fill="none" stroke="#ffd23f" stroke-width="2.6"');
  expect(modern).toContain('<circle cx="10" cy="16" r="3.1" fill="#ff5f9e"/>');
  const classic = readFileSync(repositoryPath("programs/iphone4s/Icon.svg"), "utf8");
  expect(classic).toContain('rx="6" fill="none" stroke="#efce77" stroke-width="2.6"');
  expect(classic).toContain('<circle cx="10" cy="16" r="3.1" fill="#dc91ad"/>');
  expect(classic).toContain('width="10" height="2.2" rx="1.1" fill="#83c6d0"/>');
});
