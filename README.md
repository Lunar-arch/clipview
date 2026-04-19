# clipview

clipview is a Playwright-based screenshot and stream CLI for local development workflows. It can either capture a reachable URL, or it can act as a dev-server wrapper that starts or attaches to an app, finds the port, and keeps taking screenshots as the page changes.

## How It Works

The package has three layers:

- The CLI entrypoint in [packages/screenshot-kit/cli.mjs](packages/screenshot-kit/cli.mjs) parses `clipview`, `clipview dev`, `clipview attach`, and `clipview setup`.
- The runtime in [packages/screenshot-kit/index.mjs](packages/screenshot-kit/index.mjs) launches Playwright, resolves the target URL, and captures screenshots.
- The onboarding flow in [packages/screenshot-kit/onboarding.mjs](packages/screenshot-kit/onboarding.mjs) asks for a preferred dev command, port, and output style, then stores those defaults in a local config file.

That split matters because `clipview dev` is not just a screenshot command. It is a wrapper that:

1. Detects the likely framework from `package.json`.
2. Infers a probable dev command from scripts and dependencies.
3. Starts the dev server.
4. Watches stdout and stderr for a URL or port.
5. Falls back to config or common port scanning if the server does not print a usable URL.
6. Attaches capture streaming once the server is ready.

`clipview attach` uses the same capture pipeline, but it skips spawning a dev server and connects to an already running one.

## Features

- Framework-aware dev lifecycle wrapper via `clipview dev`.
- Attach mode via `clipview attach`.
- Stdout-driven port detection with config and scan fallbacks.
- Interactive onboarding for dev command, preferred port, and output mode.
- Output modes:
  - `--mode structured` for cleaner logs.
  - `--mode raw` for passthrough logs.
- Multi-route support:
  - `clipview dev --path / /dashboard /settings`
- Browser console mirroring with `--browserConsole`.

## Install

```bash
npm install -g clipview
```

On interactive installs, setup asks for:

- preferred dev command
- preferred dev port
- clean output mode

If clean output is enabled, clipview can install `concurrently` for the project after install completes. If browser binaries are missing:

```bash
npx playwright install chromium
```

## Commands

```bash
clipview [target] [options]
clipview dev [options]
clipview attach [options]
clipview setup
```

- `clipview dev`:
  - detects likely framework names such as Next.js, Nuxt, Vite, React, Vue, SvelteKit, Astro, Remix, Angular, and more
  - infers a likely dev command from `package.json`
  - starts the server and listens for the actual port or URL in output
  - auto-starts streaming once the app is reachable

- `clipview attach`:
  - connects to an existing local server
  - resolves the target in this order: explicit `--port`, config `port`, then common port scanning
  - auto-starts streaming once the server responds

- `clipview setup`:
  - reruns onboarding manually

## Common Workflows

One-shot screenshot from a live site:

```bash
clipview https://example.com --capture viewport --name landing
```

Dev server wrapper with multiple routes:

```bash
clipview dev --path / /dashboard /settings --mode structured
```

Attach to an already running app:

```bash
clipview attach --port 5173 --path /
```

Local file mode:

```bash
clipview --file ./dist/index.html --scroll selectors --scrollSelectors "#hero,#pricing"
```

## Output Modes

`--mode raw` writes server output as-is. `--mode structured` rewrites the most useful lines into a cleaner, easier-to-scan format.

Typical structured output looks like this:

```text
GET / 200 | Saved
GET /api/data 400
Error failed to fetch data
```

This mode is intentionally conservative. It keeps meaningful request and error lines, while hiding some noisy framework internals where possible. The first formatter is tuned for Next.js-style logs, and it is meant to grow over time.

## Configuration

clipview reads defaults from JSON in the current working directory:

- `clipview.config.json`
- `.clipviewrc.json`
- `.clipviewrc`

Example:

```json
{
	"port": 3000,
	"devCommand": "npm run dev",
	"mode": "structured",
	"paths": ["/", "/dashboard", "/settings"],
	"attachPorts": [3000, 3001, 5173, 5174, 8080, 4200],
	"pageLoadTimeoutMs": 60000,
	"devUrlTimeoutMs": 90000,
	"waitForTimeout": 15000,
	"streamPollMs": 700,
	"minIntervalMs": 1200,
	"debounceMs": 300,
	"maxHistory": 5,
	"latestName": "latest.png",
	"stableAfterLoadMs": 120
}
```

CLI flags always override config values. The onboarding flow writes the same config file so the package remembers your defaults after the first interactive install.

## Stream Behavior

- Stream mode stores rolling history and updates `latest.png` on every capture.
- Multi-route stream mode cycles through every provided route.
- `--browserConsole` mirrors browser console output, page errors, and failed requests into the terminal.
- `--streamReload` forces reload-based polling instead of the page-mutation observer.

## Command Module Contract

Command modules can export `default` or `run` async function and receive:

`{ page, context, browser, baseUrl, outDir, playwright, options, helpers, log }`
