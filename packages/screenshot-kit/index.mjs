import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { createDevOutputFormatter } from "./dev-output.mjs";
import {
  detectProjectContext,
  inferDevCommand,
  inferSuggestedPort,
} from "./framework-detection.mjs";
import { maybeRunOnboarding } from "./onboarding.mjs";

const DEFAULTS = {
  source: "dev",
  path: "/",
  paths: ["/"],
  outDir: "screenshots",
  sizes: ["lg"],
  scroll: "none",
  scrollStep: 500,
  scrollDelay: 150,
  waitForTimeout: 15000,
  pageLoadTimeoutMs: 60000,
  devUrlTimeoutMs: 90000,
  delay: 0,
  capture: "full",
  format: "png",
  quality: 80,
  waitUntil: "load",
  headless: true,
  stream: false,
  streamPollMs: 700,
  minIntervalMs: 1200,
  debounceMs: 300,
  maxHistory: 5,
  latestName: "latest.png",
  stableAfterLoadMs: 120,
  streamReload: false,
  defaultStreamUrl: "http://localhost:3000",
  mode: "raw",
  devCommand: null,
  attachPorts: [3000, 3001, 5173, 5174, 4173, 4174, 8080, 8081, 4200, 4321, 8000],
};

const BREAKPOINTS = {
  sm: { width: 640, height: 900 },
  md: { width: 768, height: 900 },
  lg: { width: 1024, height: 900 },
  xl: { width: 1280, height: 900 },
};

const CONFIG_FILE_NAMES = [
  "clipview.config.json",
  ".clipviewrc.json",
  ".clipviewrc",
];

function toPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function toNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function normalizeRoute(input) {
  if (!input) {
    return "/";
  }
  return input.startsWith("/") ? input : `/${input}`;
}

function normalizeRouteList(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeRoute(String(item).trim())).filter(Boolean);
  }

  if (typeof value === "string") {
    return parseList(value).map((item) => normalizeRoute(item));
  }

  return [];
}

function routeToLabel(route) {
  if (!route || route === "/") {
    return "root";
  }

  return route
    .replace(/^\/+/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "route";
}

function extractPortFromText(input) {
  const directUrl = input.match(/https?:\/\/[\w.:[\]-]+:(\d{2,5})/i);
  if (directUrl?.[1]) {
    return Number(directUrl[1]);
  }

  const nextStyle = input.match(/started server on[^\d]*(\d{2,5})/i);
  if (nextStyle?.[1]) {
    return Number(nextStyle[1]);
  }

  const localStyle = input.match(/local:\s*https?:\/\/[\w.:[\]-]+:(\d{2,5})/i);
  if (localStyle?.[1]) {
    return Number(localStyle[1]);
  }

  const listenStyle = input.match(/listening on[^\d]*(\d{2,5})/i);
  if (listenStyle?.[1]) {
    return Number(listenStyle[1]);
  }

  return null;
}

function parseList(input) {
  if (!input) {
    return [];
  }
  return input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeListOption(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return parseList(value);
  }

  return [];
}

function normalizeTargetUrl(input) {
  if (!input) {
    return input;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }

  const normalized = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) || trimmed.startsWith("file:") ? trimmed : `http://${trimmed}`;
  return new URL(normalized).toString().replace(/\/$/, "");
}

async function loadJsonConfig(filePath) {
  const content = await fs.readFile(filePath, "utf8");

  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must contain a JSON object.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${filePath}`);
    }

    throw new Error(`Config file ${filePath} ${error.message}`);
  }
}

async function loadConfigDefaults(argv) {
  let explicitConfigPath = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config" || arg === "-C") {
      const nextValue = argv[i + 1];
      if (!nextValue || nextValue.startsWith("-")) {
        throw new Error("--config requires a file path.");
      }

      explicitConfigPath = nextValue;
      break;
    }
  }

  const configPath = explicitConfigPath
    ? path.resolve(process.cwd(), explicitConfigPath)
    : CONFIG_FILE_NAMES.map((name) => path.resolve(process.cwd(), name)).find((candidate) => existsSync(candidate)) ?? null;

  if (!configPath) {
    return {};
  }

  return loadJsonConfig(configPath);
}

function parseViewportToken(token) {
  if (token in BREAKPOINTS) {
    return { label: token, viewport: BREAKPOINTS[token] };
  }

  const match = token.match(/^(\d+)x(\d+)$/i);
  if (!match) {
    throw new Error(
      `Invalid size \"${token}\". Use one of ${Object.keys(BREAKPOINTS).join(", ")} or WIDTHxHEIGHT.`
    );
  }

  const width = toPositiveInteger(match[1], "viewport width");
  const height = toPositiveInteger(match[2], "viewport height");
  return { label: `${width}x${height}`, viewport: { width, height } };
}

export async function parseScreenshotArgs(argv, baseOptions = {}) {
  const configDefaults = await loadConfigDefaults(argv);
  const baseSource = typeof baseOptions.source === "string" ? baseOptions.source : null;
  const options = {
    ...DEFAULTS,
    ...configDefaults,
    ...baseOptions,
    help: false,
    commands: baseOptions.commands ?? configDefaults.commands ?? null,
    port: baseOptions.port ?? configDefaults.port ?? null,
    name: baseOptions.name ?? configDefaults.name ?? null,
    url: baseOptions.url ?? configDefaults.url ?? null,
    file: baseOptions.file ?? configDefaults.file ?? null,
    htmlFile: baseOptions.htmlFile ?? configDefaults.htmlFile ?? null,
    folderName: baseOptions.folderName ?? configDefaults.folderName ?? null,
    waitFor: normalizeListOption(baseOptions.waitFor ?? configDefaults.waitFor ?? []),
    scrollSelectors: normalizeListOption(baseOptions.scrollSelectors ?? configDefaults.scrollSelectors ?? []),
    browserConsole: Boolean(baseOptions.browserConsole ?? configDefaults.browserConsole ?? false),
    devCommand: baseOptions.devCommand ?? configDefaults.devCommand ?? null,
    mode: String(baseOptions.mode ?? configDefaults.mode ?? DEFAULTS.mode).toLowerCase(),
    paths: normalizeRouteList(baseOptions.paths ?? configDefaults.paths ?? []),
  };

  let positionalTarget = null;
  let explicitSourceSet = false;
  let explicitSourceKind = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--commands" || arg === "-c") {
      options.commands = argv[++i] ?? null;
      continue;
    }

    if (arg === "--config" || arg === "-C") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) {
        throw new Error("--config requires a file path.");
      }

      i += 1;
      continue;
    }

    if (arg === "--port" || arg === "-p") {
      options.port = toPositiveInteger(argv[++i], "--port");
      continue;
    }

    if (arg === "--path" || arg === "--directory" || arg === "-d") {
      if (!argv[i + 1] || argv[i + 1].startsWith("-")) {
        throw new Error("--path requires at least one route value.");
      }

      options.paths = options.paths ?? [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        i += 1;
        options.paths.push(normalizeRoute(argv[i]));
      }

      if (options.paths.length > 0) {
        options.path = options.paths[0];
      }
      continue;
    }

    if (arg === "--outDir" || arg === "-o") {
      options.outDir = argv[++i] ?? DEFAULTS.outDir;
      continue;
    }

    if (arg === "--name" || arg === "-n") {
      options.name = argv[++i] ?? null;
      continue;
    }

    if (arg === "--sizes" || arg === "-s") {
      options.sizes = parseList(argv[++i]);
      continue;
    }

    if (arg === "--url") {
      options.url = normalizeTargetUrl(argv[++i] ?? null);
      explicitSourceSet = true;
      explicitSourceKind = "url";
      continue;
    }

    if (arg === "--file") {
      options.file = argv[++i] ?? null;
      explicitSourceSet = true;
      explicitSourceKind = "file";
      continue;
    }

    if (arg === "--htmlFile") {
      options.htmlFile = argv[++i] ?? null;
      explicitSourceSet = true;
      explicitSourceKind = "html";
      continue;
    }

    if (arg === "--folderName") {
      options.folderName = argv[++i] ?? null;
      continue;
    }

    if (arg === "--waitFor") {
      options.waitFor = parseList(argv[++i]);
      continue;
    }

    if (arg === "--waitForTimeout") {
      options.waitForTimeout = toPositiveInteger(argv[++i], "--waitForTimeout");
      continue;
    }

    if (arg === "--delay") {
      options.delay = toPositiveInteger(argv[++i], "--delay");
      continue;
    }

    if (arg === "--scroll") {
      const mode = (argv[++i] ?? "none").toLowerCase();
      if (!["none", "page", "selectors"].includes(mode)) {
        throw new Error("--scroll must be one of: none, page, selectors.");
      }
      options.scroll = mode;
      continue;
    }

    if (arg === "--scrollSelectors") {
      options.scrollSelectors = parseList(argv[++i]);
      continue;
    }

    if (arg === "--scrollStep") {
      options.scrollStep = toPositiveInteger(argv[++i], "--scrollStep");
      continue;
    }

    if (arg === "--scrollDelay") {
      options.scrollDelay = toPositiveInteger(argv[++i], "--scrollDelay");
      continue;
    }

    if (arg === "--capture") {
      const mode = (argv[++i] ?? "full").toLowerCase();
      if (!["full", "viewport"].includes(mode)) {
        throw new Error("--capture must be one of: full, viewport.");
      }
      options.capture = mode;
      continue;
    }

    if (arg === "--format") {
      const format = (argv[++i] ?? "png").toLowerCase();
      if (!["png", "jpeg", "webp"].includes(format)) {
        throw new Error("--format must be one of: png, jpeg, webp.");
      }
      options.format = format;
      continue;
    }

    if (arg === "--quality") {
      const quality = toPositiveInteger(argv[++i], "--quality");
      if (quality < 1 || quality > 100) {
        throw new Error("--quality must be between 1 and 100.");
      }
      options.quality = quality;
      continue;
    }

    if (arg === "--waitUntil") {
      const waitUntil = argv[++i] ?? "load";
      if (!["load", "domcontentloaded", "networkidle", "commit"].includes(waitUntil)) {
        throw new Error("--waitUntil must be one of: load, domcontentloaded, networkidle, commit.");
      }
      options.waitUntil = waitUntil;
      continue;
    }

    if (arg === "--timeout") {
      options.pageLoadTimeoutMs = toPositiveInteger(argv[++i], "--timeout");
      continue;
    }

    if (arg === "--devTimeout") {
      options.devUrlTimeoutMs = toPositiveInteger(argv[++i], "--devTimeout");
      continue;
    }

    if (arg === "--headed") {
      options.headless = false;
      continue;
    }

    if (arg === "--headless") {
      options.headless = true;
      continue;
    }

    if (arg === "--stream") {
      options.stream = true;
      continue;
    }

    if (arg === "--live") {
      options.stream = true;
      continue;
    }

    if (arg === "--streamPoll") {
      options.streamPollMs = toPositiveInteger(argv[++i], "--streamPoll");
      continue;
    }

    if (arg === "--minInterval") {
      options.minIntervalMs = toNonNegativeInteger(argv[++i], "--minInterval");
      continue;
    }

    if (arg === "--debounce") {
      options.debounceMs = toNonNegativeInteger(argv[++i], "--debounce");
      continue;
    }

    if (arg === "--maxHistory") {
      options.maxHistory = toPositiveInteger(argv[++i], "--maxHistory");
      continue;
    }

    if (arg === "--latestName") {
      options.latestName = argv[++i] ?? DEFAULTS.latestName;
      continue;
    }

    if (arg === "--stableWait") {
      options.stableAfterLoadMs = toNonNegativeInteger(argv[++i], "--stableWait");
      continue;
    }

    if (arg === "--streamReload") {
      options.streamReload = true;
      continue;
    }

    if (arg === "--devCommand") {
      const nextValue = argv[++i] ?? null;
      if (!nextValue || nextValue.startsWith("-")) {
        throw new Error("--devCommand requires a command string.");
      }
      options.devCommand = nextValue;
      continue;
    }

    if (arg === "--mode") {
      const mode = String(argv[++i] ?? DEFAULTS.mode).toLowerCase();
      if (!["structured", "raw"].includes(mode)) {
        throw new Error("--mode must be one of: structured, raw.");
      }
      options.mode = mode;
      continue;
    }

    if (arg === "--browserConsole" || arg === "--browser-console") {
      options.browserConsole = true;
      continue;
    }

    if (!arg.startsWith("-")) {
      if (positionalTarget !== null) {
        throw new Error(`Unexpected positional argument: ${arg}`);
      }

      positionalTarget = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (positionalTarget !== null) {
    if (explicitSourceSet) {
      throw new Error("A positional target cannot be combined with --url, --file, or --htmlFile.");
    }

    options.url = normalizeTargetUrl(positionalTarget);
      explicitSourceKind = "url";
  }

  if (explicitSourceKind) {
    options.source = explicitSourceKind;
  } else if (baseSource) {
    options.source = baseSource;
  } else if (options.url) {
    options.source = "url";
  } else if (options.file) {
    options.source = "file";
  } else if (options.htmlFile) {
    options.source = "html";
  } else if (options.stream && !options.port) {
    // Stream mode defaults to existing host dev server when no explicit source is provided.
    options.source = "url";
    options.url = options.defaultStreamUrl;
  }

  options.sizes = normalizeListOption(options.sizes);
  options.waitFor = normalizeListOption(options.waitFor);
  options.scrollSelectors = normalizeListOption(options.scrollSelectors);
  options.paths = normalizeRouteList(options.paths);

  if (options.paths.length === 0) {
    options.paths = [normalizeRoute(options.path)];
  }

  options.path = options.paths[0];

  if (!["structured", "raw"].includes(options.mode)) {
    throw new Error("--mode must be one of: structured, raw.");
  }

  if (!options.latestName.toLowerCase().endsWith(".png")) {
    throw new Error("--latestName must end with .png.");
  }

  return options;
}

export function printHelp() {
  console.log(`Usage:
  clipview [target] [options]
  clipview dev [options]
  clipview attach [options]
  clipview setup

Subcommands:
  dev                      Start a detected dev server and stream captures automatically.
  attach                   Attach to an already-running dev server, then stream.
  setup                    Run onboarding prompts (dev command, port, output mode).

Core options:
  -c, --commands <file>      Path to a Playwright command module.
  -C, --config <file>        Load defaults from a JSON config file.
  -p, --port <number>        Preferred port for dev/attach flows.
  -d, --path <route...>      One or more routes. Supports repeated flags or a route list.
  -o, --outDir <dir>         Output base directory. Default: screenshots
  -n, --name <name>          Base screenshot name.
  -s, --sizes <sizes>        Comma list: sm,md,lg,xl or WIDTHxHEIGHT. Default: lg
      --devCommand <cmd>     Explicit command used when source is dev.
      --mode <mode>          structured or raw. Default: raw

Source options:
      --url <https://...>    Capture from an already reachable URL.
      --file <path.html>     Capture from local HTML file (file://), no localhost required.
      --htmlFile <path.html> Load raw HTML content with setContent, no server required.
      --folderName <name>    Output subfolder name (default: timestamp).

Capture behavior:
      --waitFor <selectors>  Comma-separated selectors to wait for.
      --waitForTimeout <ms>  Timeout for each selector wait. Default: 15000
      --delay <ms>           Delay before screenshot. Default: 0
      --capture <mode>       full or viewport. Default: full
      --format <type>        png, jpeg, webp. Default: png
      --quality <1-100>      Quality for jpeg/webp. Default: 80
      --waitUntil <mode>     load, domcontentloaded, networkidle, commit
      --timeout <ms>         Page load timeout. Default: 60000
      --headed               Run browser in headed mode.

Scroll automation:
      --scroll <mode>        none, page, selectors. Default: none
      --scrollSelectors <s>  Comma selectors for --scroll selectors mode.
      --scrollStep <px>      Pixels moved per page scroll step. Default: 500
      --scrollDelay <ms>     Delay between scroll steps. Default: 150

Live stream mode:
  --stream               Enable continuous refresh + auto-capture mode.
  --live                 Alias for --stream.
  --streamPoll <ms>      Polling interval for change checks. Default: 700
  --debounce <ms>        Debounce after change detection. Default: 300
  --minInterval <ms>     Minimum time between captures. Default: 1200
      --maxHistory <count>   Keep only newest N stream images. Default: 5
  --latestName <file>    Overwritten on every capture. Default: latest.png
  --stableWait <ms>      Extra settle delay after load-state checks. Default: 120
  --streamReload         Force legacy reload polling.
      --browserConsole       Mirror browser console, page errors, and request failures.

Examples:
  clipview --sizes sm,lg --scroll page
  clipview https://example.com --capture viewport --name landing
  clipview dev --path / /dashboard /settings --mode structured
  clipview attach --mode structured
  clipview attach --port 5173 --path /

Command file contract:
  Export an async function (default export or named 'run').
  It receives: { page, context, browser, baseUrl, outDir, playwright, options, helpers, log }.
`);
}

function normalizeDevUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (["0.0.0.0", "::", "[::]"].includes(url.hostname)) {
    url.hostname = "localhost";
  }
  return url.toString().replace(/\/$/, "");
}

function extractUrlFromChunk(chunk) {
  const matches = chunk.match(/https?:\/\/[^\s"')]+/gi) ?? [];
  for (const candidate of matches) {
    try {
      return normalizeDevUrl(candidate.replace(/[.,;:]$/, ""));
    } catch {
      // Ignore invalid URL tokens in noisy logs.
    }
  }
  return null;
}

function waitForDevUrl(devProcess, config) {
  const {
    requestedPort,
    fallbackPort,
    timeoutMs,
    formatter,
  } = config;

  return new Promise((resolve, reject) => {
    let settled = false;

    const flushFormatter = () => {
      const trailing = formatter?.flush?.();
      if (trailing) {
        process.stdout.write(trailing);
      }
    };

    const finish = (result, error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      devProcess.stdout.off("data", onStdoutData);
      devProcess.stderr.off("data", onStderrData);
      devProcess.off("exit", onExit);
      flushFormatter();

      if (error) {
        reject(error);
        return;
      }

      resolve(result);
    };

    const timer = setTimeout(() => {
      if (requestedPort) {
        finish(`http://localhost:${requestedPort}`);
        return;
      }
      if (fallbackPort) {
        finish(`http://localhost:${fallbackPort}`);
        return;
      }

      finish(null, new Error("Timed out waiting for dev server URL in output. Use --port or config fallback."));
    }, timeoutMs);

    const handleData = (data) => {
      if (settled) {
        return;
      }

      const output = data.toString();
      const extracted = extractUrlFromChunk(output);
      if (!extracted) {
        const extractedPort = extractPortFromText(output);
        if (extractedPort) {
          finish(`http://localhost:${extractedPort}`);
        }
        return;
      }

      finish(extracted);
    };

    const onStdoutData = (data) => {
      const next = formatter ? formatter.formatStdout(data) : data.toString();
      if (next) {
        process.stdout.write(next);
      }
      handleData(data);
    };

    const onStderrData = (data) => {
      const next = formatter ? formatter.formatStderr(data) : data.toString();
      if (next) {
        process.stderr.write(next);
      }
      handleData(data);
    };

    const onExit = (code) => {
      finish(null, new Error(`Dev server exited before URL was found (exit code ${code}).`));
    };

    devProcess.stdout.on("data", onStdoutData);
    devProcess.stderr.on("data", onStderrData);
    devProcess.once("exit", onExit);
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      resolve();
    }, 5000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function createFolderName() {
  const now = new Date();
  const month = String(now.getMonth() + 1);
  const day = String(now.getDate());
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const ampm = now.getHours() >= 12 ? "PM" : "AM";
  return `${month}-${day}-${year}_${hours}-${minutes}${ampm}`;
}

function createScreenshotName(index, customName, label, multiple, format) {
  let filename = customName ? customName.replace(/[^a-zA-Z0-9_-]+/g, "-") : `screenshot${index}`;
  if (multiple && label) {
    filename += `-${label}`;
  }
  return `${filename}.${format}`;
}

async function runCommandModule(modulePath, payload) {
  if (!modulePath) {
    return;
  }

  const absolutePath = path.resolve(process.cwd(), modulePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Command file not found: ${absolutePath}`);
  }

  const imported = await import(pathToFileURL(absolutePath).href);
  const runner = imported.default ?? imported.run;

  if (typeof runner !== "function") {
    throw new Error("Command file must export an async function as default export or named export 'run'.");
  }

  await runner(payload);
}

export async function autoScrollPage(page, config = {}) {
  const step = config.step ?? DEFAULTS.scrollStep;
  const delay = config.delay ?? DEFAULTS.scrollDelay;

  await page.evaluate(
    async ({ internalStep, internalDelay }) => {
      await new Promise((resolve) => {
        let totalScrolled = 0;

        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, internalStep);
          totalScrolled += internalStep;

          if (totalScrolled >= scrollHeight - window.innerHeight) {
            clearInterval(timer);
            resolve();
          }
        }, internalDelay);
      });
    },
    { internalStep: step, internalDelay: delay }
  );
}

export async function autoScrollSelectors(page, selectors, config = {}) {
  const delay = config.delay ?? DEFAULTS.scrollDelay;

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "attached", timeout: config.timeout ?? DEFAULTS.waitForTimeout });
    await locator.scrollIntoViewIfNeeded();
    if (delay > 0) {
      await page.waitForTimeout(delay);
    }
  }
}

async function isReachableHttpUrl(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });

    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveAttachUrl(options) {
  if (options.url) {
    return options.url.replace(/\/$/, "");
  }

  if (options.port) {
    return `http://localhost:${options.port}`;
  }

  for (const port of options.attachPorts) {
    const candidate = `http://localhost:${port}`;
    // Keep attach mode resilient by scanning common framework defaults quickly.
    if (await isReachableHttpUrl(candidate)) {
      return candidate;
    }
  }

  throw new Error("Attach mode could not find a reachable dev server. Try --port or set port in config.");
}

async function prepareSource(options) {
  if (options.source === "url") {
    if (!options.url) {
      throw new Error("--url is required when source is url.");
    }
    return { baseUrl: options.url.replace(/\/$/, ""), targetKind: "goto" };
  }

  if (options.source === "file") {
    if (!options.file) {
      throw new Error("--file is required when source is file.");
    }

    const absolutePath = path.resolve(process.cwd(), options.file);
    if (!existsSync(absolutePath)) {
      throw new Error(`--file not found: ${absolutePath}`);
    }

    return { baseUrl: pathToFileURL(absolutePath).toString(), targetKind: "goto" };
  }

  if (options.source === "html") {
    if (!options.htmlFile) {
      throw new Error("--htmlFile is required when source is html.");
    }

    const absolutePath = path.resolve(process.cwd(), options.htmlFile);
    if (!existsSync(absolutePath)) {
      throw new Error(`--htmlFile not found: ${absolutePath}`);
    }

    const html = await fs.readFile(absolutePath, "utf8");
    return { baseUrl: "about:blank", targetKind: "content", html };
  }

  if (options.source === "attach") {
    const attachUrl = await resolveAttachUrl(options);
    return { baseUrl: attachUrl, targetKind: "goto" };
  }

  return { baseUrl: null, targetKind: "goto" };
}

async function loadTarget(page, sourceInfo, targetUrl, options) {
  if (sourceInfo.targetKind === "content") {
    await page.setContent(sourceInfo.html, {
      waitUntil: options.waitUntil,
      timeout: options.pageLoadTimeoutMs,
    });
    return null;
  }

  return page.goto(targetUrl, {
    waitUntil: options.waitUntil,
    timeout: options.pageLoadTimeoutMs,
  });
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatLocation(location) {
  if (!location?.url) {
    return "";
  }

  const line = location.lineNumber ? location.lineNumber + 1 : 1;
  const column = location.columnNumber ? location.columnNumber + 1 : 1;
  return ` (${location.url}:${line}:${column})`;
}

function attachBrowserLogging(page, enabled) {
  if (!enabled) {
    return () => {};
  }

  const onConsole = (message) => {
    const prefix = `[browser:${message.type()}]`;
    const location = formatLocation(message.location());

    if (message.type() === "error") {
      console.error(prefix, message.text() + location);
      return;
    }

    if (message.type() === "warning") {
      console.warn(prefix, message.text() + location);
      return;
    }

    console.log(prefix, message.text() + location);
  };

  const onPageError = (error) => {
    console.error("[browser:error]", error.message);
  };

  const onRequestFailed = (request) => {
    const failure = request.failure();
    console.warn("[browser:requestfailed]", request.method(), request.url(), failure?.errorText ?? "request failed");
  };

  const onResponse = (response) => {
    if (response.status() >= 400) {
      console.warn("[browser:http]", `${response.status()} ${response.statusText()} ${response.url()}`);
    }
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  return () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
  };
}

async function installStreamObserver(page) {
  await page.evaluate(() => {
    const globalKey = "__remoteScreenSnap";
    if (window[globalKey]?.installed) {
      return;
    }

    const state = {
      installed: true,
      dirty: false,
      lastMutationAt: 0,
    };

    const markDirty = () => {
      state.dirty = true;
      state.lastMutationAt = Date.now();
    };

    const observer = new MutationObserver(() => {
      markDirty();
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });

    const originalPush = history.pushState;
    history.pushState = function patchedPushState(...args) {
      const result = originalPush.apply(this, args);
      markDirty();
      return result;
    };

    const originalReplace = history.replaceState;
    history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplace.apply(this, args);
      markDirty();
      return result;
    };

    window.addEventListener("popstate", markDirty, { passive: true });
    window.addEventListener("hashchange", markDirty, { passive: true });

    state.consumeDirty = () => {
      const now = Date.now();
      const dirtyNow = state.dirty;
      state.dirty = false;
      return {
        dirty: dirtyNow,
        idleForMs: state.lastMutationAt ? now - state.lastMutationAt : Number.MAX_SAFE_INTEGER,
      };
    };

    window[globalKey] = state;
  });
}

async function consumeStreamDirty(page) {
  return page.evaluate(() => {
    const state = window.__remoteScreenSnap;
    if (!state || typeof state.consumeDirty !== "function") {
      return { dirty: false, idleForMs: Number.MAX_SAFE_INTEGER };
    }
    return state.consumeDirty();
  });
}

async function ensurePageStable(page, options) {
  await page.waitForLoadState("domcontentloaded", {
    timeout: options.pageLoadTimeoutMs,
  });

  try {
    await page.waitForLoadState(options.waitUntil, {
      timeout: options.pageLoadTimeoutMs,
    });
  } catch {
    // Keep stream mode resilient for apps that never reach networkidle due to HMR sockets.
  }

  // Always do a best-effort network idle wait for visually stable captures.
  if (options.waitUntil !== "networkidle") {
    try {
      await page.waitForLoadState("networkidle", {
        timeout: Math.min(options.pageLoadTimeoutMs, 5000),
      });
    } catch {
      // HMR websocket activity can keep pages from becoming fully idle.
    }
  }

  try {
    await page.waitForFunction(() => document.readyState === "complete", {
      timeout: options.pageLoadTimeoutMs,
    });
  } catch {
    // Some pages intentionally keep transitions active; a best-effort check is enough.
  }

  if (options.stableAfterLoadMs > 0) {
    await page.waitForTimeout(options.stableAfterLoadMs);
  }
}

async function runCapturePreparation({
  browser,
  context,
  page,
  baseUrl,
  outDir,
  options,
  sourceInfo,
  targetUrl,
}) {
  const response = await loadTarget(page, sourceInfo, targetUrl, options);

  if (response && !response.ok()) {
    console.warn("[clipview]", `${response.status()} ${response.statusText()} ${response.url()}`);
  }

  await runCommandModule(options.commands, {
    browser,
    context,
    page,
    baseUrl,
    outDir,
    playwright: { chromium },
    options,
    helpers: {
      autoScrollPage: (config) => autoScrollPage(page, config),
      autoScrollSelectors: (selectors, config) => autoScrollSelectors(page, selectors, config),
    },
    log: (...messages) => console.log("[commands]", ...messages),
  });

  for (const selector of options.waitFor) {
    await page.waitForSelector(selector, { timeout: options.waitForTimeout });
  }

  await ensurePageStable(page, options);

  if (options.delay > 0) {
    await page.waitForTimeout(options.delay);
  }
}

async function applyScrollStrategy(page, options) {
  if (options.scroll === "page") {
    await autoScrollPage(page, {
      step: options.scrollStep,
      delay: options.scrollDelay,
    });
    return;
  }

  if (options.scroll === "selectors" && options.scrollSelectors.length > 0) {
    await autoScrollSelectors(page, options.scrollSelectors, {
      delay: options.scrollDelay,
      timeout: options.waitForTimeout,
    });
  }
}

function buildScreenshotConfig(filePath, options) {
  const config = {
    path: filePath,
    fullPage: options.capture === "full",
    type: options.format,
  };

  if (options.format === "jpeg" || options.format === "webp") {
    config.quality = options.quality;
  }

  return config;
}

async function getPageSignature(page) {
  const [url, html] = await Promise.all([
    page.url(),
    page.content(),
  ]);

  return createHash("sha1")
    .update(url)
    .update("\n")
    .update(html)
    .digest("hex");
}

async function trimStreamHistory(outDir, maxHistory) {
  const entries = await fs.readdir(outDir, { withFileTypes: true });
  const historyFiles = entries
    .filter((entry) => entry.isFile() && /^stream(?:-[a-z0-9-]+)?-\d{6}\.png$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (historyFiles.length <= maxHistory) {
    return;
  }

  const toDelete = historyFiles.slice(0, historyFiles.length - maxHistory);
  await Promise.all(
    toDelete.map((name) => fs.unlink(path.join(outDir, name)).catch(() => {}))
  );
}

async function runStreamScreenshotTask({
  browser,
  context,
  page,
  baseUrl,
  outDir,
  options,
  sourceInfo,
  targetUrl,
  viewport,
}) {
  let sequence = 0;
  let lastSignature = null;
  let pendingCapture = false;
  let lastChangeAt = 0;
  let lastCaptureAt = 0;
  let shouldStop = false;

  const onStop = () => {
    shouldStop = true;
  };

  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);

  const captureNow = async (reason) => {
    const waitMs = Math.max(0, options.minIntervalMs - (Date.now() - lastCaptureAt));
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    await applyScrollStrategy(page, options);

    sequence += 1;
    const historyFile = `stream-${String(sequence).padStart(6, "0")}.png`;
    const historyPath = path.join(outDir, historyFile);
    const latestPath = path.join(outDir, options.latestName);

    await page.screenshot(buildScreenshotConfig(historyPath, options));
    await fs.copyFile(historyPath, latestPath);
    await trimStreamHistory(outDir, options.maxHistory);

    lastCaptureAt = Date.now();
    console.log(`Saved stream screenshot (${reason}): ${historyPath}`);
    console.log(`Updated latest: ${latestPath}`);
  };

  const logStreamError = (stage, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[stream] ${stage}: ${message}`);
  };

  try {
    await page.setViewportSize(viewport);

    while (!shouldStop) {
      try {
        await runCapturePreparation({
          browser,
          context,
          page,
          baseUrl,
          outDir,
          options,
          sourceInfo,
          targetUrl,
        });

        if (!options.streamReload) {
          await installStreamObserver(page);
        }

        await captureNow("initial");
        break;
      } catch (error) {
        logStreamError("initial capture failed", error);
        await sleep(options.streamPollMs);
      }
    }

    while (!shouldStop) {
      await sleep(options.streamPollMs);

      if (shouldStop) {
        break;
      }

      try {
        if (options.streamReload) {
          await runCapturePreparation({
            browser,
            context,
            page,
            baseUrl,
            outDir,
            options,
            sourceInfo,
            targetUrl,
          });

          const nextSignature = await getPageSignature(page);
          if (nextSignature) {
            if (!lastSignature) {
              lastSignature = nextSignature;
            } else if (nextSignature !== lastSignature) {
              lastSignature = nextSignature;
              lastChangeAt = Date.now();
              pendingCapture = true;
            }
          }
        } else {
          await installStreamObserver(page);
          const state = await consumeStreamDirty(page);
          if (state.dirty) {
            lastChangeAt = Date.now();
            pendingCapture = true;
          }

          if (pendingCapture && state.idleForMs < options.debounceMs) {
            continue;
          }
        }

        if (pendingCapture && Date.now() - lastChangeAt >= options.debounceMs) {
          await ensurePageStable(page, options);
          await captureNow("rerender");
          pendingCapture = false;
        }
      } catch (error) {
        pendingCapture = false;
        logStreamError("stream iteration failed", error);
      }
    }

    console.log("Stream mode stopped.");
  } finally {
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGTERM", onStop);
  }
}

async function runMultiRouteStreamTask({
  browser,
  context,
  page,
  baseUrl,
  outDir,
  options,
  sourceInfo,
  targets,
  viewport,
}) {
  let sequence = 0;
  let shouldStop = false;
  let lastCaptureAt = 0;
  const signatures = new Map();

  const onStop = () => {
    shouldStop = true;
  };

  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);

  const captureNow = async (target) => {
    const waitMs = Math.max(0, options.minIntervalMs - (Date.now() - lastCaptureAt));
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    await applyScrollStrategy(page, options);

    sequence += 1;
    const slug = routeToLabel(target.route);
    const historyFile = `stream-${slug}-${String(sequence).padStart(6, "0")}.png`;
    const historyPath = path.join(outDir, historyFile);
    const latestPath = path.join(outDir, options.latestName);

    await page.screenshot(buildScreenshotConfig(historyPath, options));
    await fs.copyFile(historyPath, latestPath);
    await trimStreamHistory(outDir, options.maxHistory);

    lastCaptureAt = Date.now();
    console.log(`Saved stream screenshot (${target.route}): ${historyPath}`);
    console.log(`Updated latest: ${latestPath}`);
  };

  const logStreamError = (target, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[stream:${target.route}] ${message}`);
  };

  try {
    await page.setViewportSize(viewport);

    while (!shouldStop) {
      for (const target of targets) {
        if (shouldStop) {
          break;
        }

        try {
          await runCapturePreparation({
            browser,
            context,
            page,
            baseUrl,
            outDir,
            options,
            sourceInfo,
            targetUrl: target.url,
          });

          const nextSignature = await getPageSignature(page);
          const previousSignature = signatures.get(target.route);
          signatures.set(target.route, nextSignature);

          if (!previousSignature || previousSignature !== nextSignature) {
            await ensurePageStable(page, options);
            await captureNow(target);
          }
        } catch (error) {
          logStreamError(target, error);
        }

        await sleep(options.streamPollMs);
      }
    }

    console.log("Stream mode stopped.");
  } finally {
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGTERM", onStop);
  }
}

export async function runScreenshotTask(rawOptions) {
  const projectDir = process.cwd();
  let options = {
    ...DEFAULTS,
    ...rawOptions,
  };

  if ((options.source === "dev" || options.source === "attach") && !process.env.CLIPVIEW_SKIP_ONBOARDING) {
    const onboardingConfig = await maybeRunOnboarding({
      projectDir,
      reason: "runtime",
    });

    if (onboardingConfig && typeof onboardingConfig === "object") {
      options = {
        ...DEFAULTS,
        ...onboardingConfig,
        ...rawOptions,
      };
    }
  }

  options.paths = normalizeRouteList(options.paths);
  if (options.paths.length === 0) {
    options.paths = [normalizeRoute(options.path)];
  }
  options.path = options.paths[0];

  options.mode = String(options.mode ?? DEFAULTS.mode).toLowerCase() === "structured" ? "structured" : "raw";
  options.attachPorts = Array.isArray(options.attachPorts)
    ? options.attachPorts
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
    : [...DEFAULTS.attachPorts];

  if (options.stream && options.source === "html") {
    throw new Error("--stream does not support --htmlFile. Use dev/url/file sources instead.");
  }

  if (options.stream) {
    options.format = "png";
  }

  const sizeTokens = options.sizes?.length ? options.sizes : DEFAULTS.sizes;
  const parsedSizes = sizeTokens.map(parseViewportToken);

  const folderName = options.folderName ?? (options.stream ? "live" : createFolderName());
  const outDir = path.resolve(process.cwd(), options.outDir, folderName);
  await fs.mkdir(outDir, { recursive: true });

  const sourceInfo = await prepareSource(options);

  let devProcess;
  let baseUrl = sourceInfo.baseUrl;
  let detachBrowserLogging = null;
  let projectContext = null;
  if (options.source === "dev") {
    projectContext = await detectProjectContext(projectDir);
    const preferredPort = inferSuggestedPort(projectContext, options.port ?? null);
    const commandInfo = inferDevCommand(projectContext, {
      configuredCommand: options.devCommand,
      requestedPort: preferredPort,
    });

    const env = {
      ...process.env,
      ...(preferredPort ? { PORT: String(preferredPort) } : {}),
    };

    console.log(`[clipview] ${projectContext.framework.name} detected`);
    console.log(`[clipview] starting dev server: ${commandInfo.command}`);

    devProcess = spawn(commandInfo.command, {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    const formatter = createDevOutputFormatter(options.mode, projectContext.framework.id);
    baseUrl = await waitForDevUrl(devProcess, {
      requestedPort: options.port,
      fallbackPort: preferredPort,
      timeoutMs: options.devUrlTimeoutMs,
      formatter,
    });
  }

  if (options.source === "attach") {
    console.log(`[clipview] attach connected: ${baseUrl}`);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: options.headless });
    const context = await browser.newContext();
    const page = await context.newPage();
    detachBrowserLogging = attachBrowserLogging(page, options.browserConsole);

    const targets = sourceInfo.targetKind === "goto"
      ? options.paths.map((route) => ({
        route,
        url: new URL(route, `${baseUrl}/`).toString(),
      }))
      : [{ route: options.path, url: baseUrl }];

    if (options.stream) {
      if (parsedSizes.length > 1) {
        console.warn("[stream] Multiple sizes provided; stream mode uses the first viewport only.");
      }

      if (targets.length > 1) {
        await runMultiRouteStreamTask({
          browser,
          context,
          page,
          baseUrl,
          outDir,
          options,
          sourceInfo,
          targets,
          viewport: parsedSizes[0].viewport,
        });
      } else {
        await runStreamScreenshotTask({
          browser,
          context,
          page,
          baseUrl,
          outDir,
          options,
          sourceInfo,
          targetUrl: targets[0].url,
          viewport: parsedSizes[0].viewport,
        });
      }

      return { outDir, baseUrl, mode: "stream" };
    }

    const multiple = parsedSizes.length > 1 || targets.length > 1;
    let screenshotIndex = 0;

    for (let i = 0; i < parsedSizes.length; i += 1) {
      const size = parsedSizes[i];
      await page.setViewportSize(size.viewport);

      for (const target of targets) {
        await runCapturePreparation({
          browser,
          context,
          page,
          baseUrl,
          outDir,
          options,
          sourceInfo,
          targetUrl: target.url,
        });

        await applyScrollStrategy(page, options);

        screenshotIndex += 1;

        const labelParts = [];
        if (parsedSizes.length > 1) {
          labelParts.push(size.label);
        }
        if (targets.length > 1) {
          labelParts.push(routeToLabel(target.route));
        }

        const variantLabel = labelParts.join("-") || size.label;
        const filename = createScreenshotName(
          screenshotIndex,
          options.name,
          variantLabel,
          multiple,
          options.format
        );
        const screenshotPath = path.join(outDir, filename);

        await page.screenshot(buildScreenshotConfig(screenshotPath, options));
        console.log(`Saved screenshot (${target.route}): ${screenshotPath}`);
      }
    }

    return { outDir, baseUrl };
  } catch (error) {
    if (typeof error?.message === "string" && error.message.includes("Executable doesn't exist")) {
      console.error("Playwright browser binaries are missing.");
      console.error("Run: pnpm exec playwright install chromium");
    }

    throw error;
  } finally {
    if (detachBrowserLogging) {
      detachBrowserLogging();
    }

    if (browser) {
      await browser.close();
    }
    await stopProcess(devProcess);
  }
}
