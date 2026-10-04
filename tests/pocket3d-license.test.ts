import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

// Pocket3D is under its own license; the rest of the repository is MIT.
const ROOT = new URL("..", import.meta.url).pathname;
const read = (path: string) => readFileSync(ROOT + path, "utf8");
const license = read("pocket3d/LICENSE");

test("the Pocket3D License keeps the MIT grant and adds the title card", () => {
  expect(license.startsWith("Pocket3D License, version 1.0")).toBe(true);
  // the grant and the disclaimer are the MIT License's
  const mit = read("LICENSE");
  const grant = "to deal in the Software\nwithout restriction, including without limitation the rights to use, copy,\nmodify, merge, publish, distribute, sublicense, and/or sell copies of the\nSoftware";
  expect(license).toContain(grant);
  expect(mit.replace(/\s+/g, " ")).toContain(grant.replace(/\s+/g, " "));
  expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  // the added conditions: the card, the PocketJS exemption, the waiver, earlier MIT copies
  for (const heading of ["2. Title card.", "3. PocketJS.", "4. Other terms.", "5. Marks.", "6. Earlier versions."]) expect(license).toContain(heading);
  expect(license).toContain("pocket3d/, devices/ and\nengine/pocket3d/");
  // the card is owed by every distributed product; a written license waives it
  expect(license).not.toMatch(/non-?commercial/i);
  expect(license).toContain("Requests: support@pocket.nexus");
  // the root license stays the MIT License
  expect(mit.startsWith("MIT License")).toBe(true);
});

test("every Pocket3D manifest and directory names the license", () => {
  for (const manifest of [
    "devices/vita/pocket-vita-gxm/Cargo.toml",
    "devices/psp/pocket-psp-ge/Cargo.toml",
    "engine/pocket3d/crates/pocket3d/Cargo.toml",
    "engine/pocket3d/crates/pocket3d-anim/Cargo.toml",
    "engine/pocket3d/crates/pocket3d-mesh/Cargo.toml",
    "engine/pocket3d/crates/pocket3d-world/Cargo.toml",
    "engine/pocket3d/crates/pocket3d-title/Cargo.toml",
  ]) {
    const path = read(manifest).match(/^license-file = "([^"]+)"$/m)?.[1];
    expect([manifest, path?.endsWith("pocket3d/LICENSE")]).toEqual([manifest, true]);
    const directory = manifest.slice(0, manifest.lastIndexOf("/") + 1);
    expect([manifest, existsSync(new URL(path!, "file://" + ROOT + directory).pathname)]).toEqual([manifest, true]);
    expect(read(manifest)).not.toMatch(/^license(\.workspace)? = /m);
  }
  for (const pointer of ["devices/LICENSE", "engine/pocket3d/LICENSE"]) expect(read(pointer)).toContain("pocket3d/LICENSE");
});

test("the package and the README state both licenses", () => {
  const pkg = JSON.parse(read("package.json"));
  expect(pkg.license).toBe("(MIT AND LicenseRef-Pocket3D-1.0)");
  // the tarball ships Pocket3D sources, so it ships their license
  for (const file of ["pocket3d/LICENSE", "devices/LICENSE", "engine/pocket3d/LICENSE"]) expect(pkg.files).toContain(file);
  const readme = read("README.md");
  expect(readme).toContain("PocketJS and MicroTS are [MIT licensed](./LICENSE)");
  expect(readme).toContain("[Pocket3D License](./pocket3d/LICENSE)");
});
