import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  detectPackageManager,
  detectProjectContext,
  inferDevCommand,
  inferSuggestedPort,
} from "./framework-detection.mjs";

const CONFIG_FILE_NAMES = [
  "clipview.config.json",
  ".clipviewrc.json",
  ".clipviewrc",
];

function isInteractive() {
  return Boolean(input.isTTY && output.isTTY && !process.env.CI);
}

function normalizeYesNo(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["y", "yes", "true", "1"].includes(normalized)) {
    return true;
  }

  if (["n", "no", "false", "0"].includes(normalized)) {
    return false;
  }

  return fallback;
}

async function loadJson(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  const raw = await fs.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed;
}

async function resolveConfigPath(projectDir) {
  for (const fileName of CONFIG_FILE_NAMES) {
    const candidate = path.join(projectDir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(projectDir, "clipview.config.json");
}

async function ensureConcurrentlyInstalled(projectDir) {
  const context = await detectProjectContext(projectDir);
  const packageJson = context.packageJson;

  if (!packageJson) {
    return;
  }

  const deps = {
    ...(packageJson.dependencies ?? {}),
    ...(packageJson.devDependencies ?? {}),
  };

  if (Object.prototype.hasOwnProperty.call(deps, "concurrently")) {
    return;
  }

  const packageManager = detectPackageManager(projectDir);

  const commandByPackageManager = {
    npm: "npm install -D concurrently",
    pnpm: "pnpm add -D concurrently",
    yarn: "yarn add -D concurrently",
    bun: "bun add -d concurrently",
  };

  const command = commandByPackageManager[packageManager] ?? commandByPackageManager.npm;

  await new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: projectDir,
      env: process.env,
      shell: true,
      stdio: "inherit",
    });

    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Failed to install concurrently (exit code ${code}).`));
    });

    child.once("error", (error) => {
      reject(error);
    });
  });
}

export async function runOnboarding(options = {}) {
  const {
    projectDir = process.cwd(),
    reason = "runtime",
    force = false,
    installConcurrently = true,
  } = options;

  if (!isInteractive()) {
    return null;
  }

  const configPath = await resolveConfigPath(projectDir);
  const existingConfig = (await loadJson(configPath)) ?? {};

  if (!force && existingConfig.onboardingCompleted) {
    return existingConfig;
  }

  const context = await detectProjectContext(projectDir);
  const suggestedPort = inferSuggestedPort(context, existingConfig.port ?? null);
  const suggestedCommand = inferDevCommand(context, {
    configuredCommand: existingConfig.devCommand ?? null,
    requestedPort: suggestedPort,
  }).command;

  const rl = readline.createInterface({ input, output });

  try {
    console.log("[clipview] Setup: detected framework", context.framework.name);

    const cleanOutputAnswer = await rl.question(
      "Enable clipview clean output mode? (y/N): "
    );

    const portAnswer = await rl.question(
      `Preferred dev port [${suggestedPort}]: `
    );

    const devCommandAnswer = await rl.question(
      `Preferred dev command [${suggestedCommand}]: `
    );

    const cleanOutput = normalizeYesNo(cleanOutputAnswer, false);
    const preferredPort = portAnswer.trim()
      ? Number(portAnswer.trim())
      : Number(suggestedPort);

    const preferredDevCommand = devCommandAnswer.trim() || suggestedCommand;

    const nextConfig = {
      ...existingConfig,
      port: Number.isInteger(preferredPort) && preferredPort > 0 ? preferredPort : suggestedPort,
      devCommand: preferredDevCommand,
      mode: cleanOutput ? "structured" : "raw",
      cleanOutput,
      onboardingCompleted: true,
      framework: context.framework.id,
      onboardingReason: reason,
    };

    await fs.writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

    if (cleanOutput && installConcurrently && reason !== "postinstall") {
      try {
        await ensureConcurrentlyInstalled(projectDir);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[clipview] Could not install concurrently automatically: ${message}`);
      }
    } else if (cleanOutput && reason === "postinstall") {
      console.warn("[clipview] Skipped automatic concurrently install during postinstall. Run `npm i -D concurrently` after install completes if you want clean output mode.");
    }

    return nextConfig;
  } finally {
    rl.close();
  }
}

export async function maybeRunOnboarding(options = {}) {
  const {
    projectDir = process.cwd(),
    reason = "runtime",
  } = options;

  const configPath = await resolveConfigPath(projectDir);
  const existingConfig = (await loadJson(configPath)) ?? {};

  if (existingConfig.onboardingCompleted) {
    return existingConfig;
  }

  return runOnboarding({
    projectDir,
    reason,
    force: false,
    installConcurrently: true,
  });
}
