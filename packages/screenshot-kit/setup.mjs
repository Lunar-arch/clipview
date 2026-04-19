#!/usr/bin/env node

import process from "node:process";
import { maybeRunOnboarding } from "./onboarding.mjs";

async function main() {
  const projectDir = process.env.INIT_CWD || process.cwd();

  if (!process.stdout.isTTY || !process.stdin.isTTY || process.env.CI) {
    return;
  }

  try {
    await maybeRunOnboarding({
      projectDir,
      reason: "postinstall",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[clipview] setup skipped: ${message}`);
  }
}

main();
