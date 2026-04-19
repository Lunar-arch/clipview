#!/usr/bin/env node

import process from "node:process";
import { parseScreenshotArgs, printHelp, runScreenshotTask } from "./index.mjs";
import { runOnboarding } from "./onboarding.mjs";

async function main() {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  let parseArgv = argv;
  let baseOptions = {};

  if (subcommand === "setup") {
    await runOnboarding({
      projectDir: process.cwd(),
      reason: "manual",
      force: true,
    });
    return;
  }

  if (subcommand === "dev") {
    parseArgv = argv.slice(1);
    baseOptions = {
      source: "dev",
      stream: true,
    };
  } else if (subcommand === "attach") {
    parseArgv = argv.slice(1);
    baseOptions = {
      source: "attach",
      stream: true,
    };
  }

  const options = await parseScreenshotArgs(parseArgv, baseOptions);

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
