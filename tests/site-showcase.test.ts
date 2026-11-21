import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderHomeShowcase } from "../site/home-showcase.ts";

const raw = readFileSync(new URL("../site/home.html", import.meta.url), "utf8");
const home = `<!doctype html><html><head><meta name="robots" content="index,follow"></head><body>${raw}<script type="module" src="/assets/landing.js"></script></body></html>`;

test("homepage generation rejects missing or duplicate insertion slots", () => {
  expect(() => renderHomeShowcase(home.replace("{{SHOWCASE_HERO}}", ""))).toThrow("Expected one homepage marker");
  expect(() => renderHomeShowcase(home + "{{SHOWCASE_DIALOGS}}")).toThrow("Expected one homepage marker");
});
