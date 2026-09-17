#!/usr/bin/env bun
import { runPerfCli } from "./perf/cli/main.ts";

if (import.meta.main) process.exitCode = await runPerfCli(process.argv.slice(2));
