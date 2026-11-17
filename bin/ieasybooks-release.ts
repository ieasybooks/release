#!/usr/bin/env bun
// The ieasybooks-release command (src/cli.ts).
import { main } from "../src/cli.ts";

process.exitCode = await main(process.argv.slice(2));
