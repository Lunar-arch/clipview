#!/usr/bin/env node

import process from "node:process";
import { parseScreenshotArgs, printHelp, runScreenshotTask } from "./index.mjs";

async function main() {
  const options = await parseScreenshotArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  await runScreenshotTask(options);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
