#!/usr/bin/env bun

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "../framework/src/manifest/plan.ts";
import { encodePocketPackage } from "../contracts/spec/pocket-package.ts";
import {
  WII_DEV_HOST_ABI,
  WII_DEV_TARGET_ID,
  resolveWiiBuildPlan,
} from "./wii-profile.ts";
import { buildGuestBundle } from "./native-host-build.ts";
import { makeVariant } from "./pocket-pack.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));

export function buildWiiGuest(app: string): void {
  if (!app || basename(app) !== app || app === "." || app === "..") {
    throw new Error("usage: bun tools/wii.ts <app>");
  }

  const manifestPath = join(repository, "apps", app, "pocket.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`PocketJS Wii: no app manifest at ${manifestPath}`);
  }

  const planPath = join(repository, ".pocket", WII_DEV_TARGET_ID, `${app}.plan.json`);
  const bundle = buildGuestBundle({
    label: "PocketJS Wii",
    repository,
    target: WII_DEV_TARGET_ID,
    resolvePlan: resolveWiiBuildPlan,
    manifestPath,
    planPath,
    outputDirectory: join(repository, "dist", "wii", "guest"),
  });
  if (
    bundle.plan.target.id !== WII_DEV_TARGET_ID ||
    bundle.plan.target.hostAbi !== WII_DEV_HOST_ABI
  ) {
    throw new Error(`PocketJS Wii: expected ${WII_DEV_TARGET_ID} ABI ${WII_DEV_HOST_ABI}`);
  }

  const packageBytes = encodePocketPackage({
    manifest: new Uint8Array(readFileSync(manifestPath)),
    variants: [
      makeVariant({
        target: bundle.plan.target.id,
        hostAbi: bundle.plan.target.hostAbi,
        planJson: canonicalJson(bundle.plan),
        identity: {
          output: bundle.plan.app.output,
          id: bundle.plan.app.id,
          title: bundle.plan.app.title,
        },
        js: new Uint8Array(readFileSync(bundle.javaScript)),
        pak: new Uint8Array(readFileSync(bundle.pack)),
      }),
    ],
  });
  const packagePath = join(
    repository,
    "dist",
    "wii",
    "guest",
    `${bundle.inputs.appOutput}.pocket`,
  );
  writeFileSync(packagePath, packageBytes);

  console.log(`PocketJS Wii: plan -> ${planPath}`);
  console.log(`PocketJS Wii: JavaScript -> ${bundle.javaScript}`);
  console.log(`PocketJS Wii: pak -> ${bundle.pack}`);
  console.log(
    `PocketJS Wii: package -> ${packagePath} (${packageBytes.length}B, ` +
      `${WII_DEV_TARGET_ID} abi ${WII_DEV_HOST_ABI})`,
  );
}

export function buildWiiLibrary(): void {
  execFileSync("make", ["-C", join(repository, "hosts", "wii"), "library"], {
    stdio: "inherit",
  });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("usage: bun tools/wii.ts <app> | --library");
  if (args[0] === "--library") buildWiiLibrary();
  else buildWiiGuest(args[0]!);
}
