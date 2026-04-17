# screensnip

`screensnip` is a Playwright-based CLI and API for automated screenshots, including a live visual streaming mode designed for development environments where direct browser access is limited.

## What It Does

- Captures screenshots from a dev server, URL, local file, or HTML file.
- Supports scrolling automation and viewport presets.
- Provides live stream mode with:
	- automatic rerender detection
	- debounce + min interval controls
	- rolling history cleanup
	- continuously overwritten `latest.png` for quick preview in VS Code
	- browser console and page error logging when enabled

## Install

```bash
npm install
```

To publish or install the CLI globally, use the package name `screensnip`.

## CLI Usage

Run the CLI directly from the repo:

```bash
npm run screensnip -- --help
```

Quick one-shot example:

```bash
npm run screensnip -- https://example.com --path / --sizes lg
```

Live stream mode:

```bash
npm run screensnip:stream -- localhost:3000 --path /
```

Minimal command (uses sensible defaults):

```bash
npm run screensnip -- --stream
```

Default stream assumptions:

- target URL: `http://localhost:3000`
- output: `./screenshots/live`
- rolling max history: `5`
- min interval: `1200ms`
- debounce: `300ms`
- poll interval: `700ms`

Or with explicit controls:

```bash
npm run screensnip -- localhost:3000 --stream --path /dashboard --outDir screenshots --folderName live --maxHistory 80 --minInterval 1500 --debounce 400 --streamPoll 1000 --browserConsole
```

## Config File

`screensnip` reads defaults from a JSON config file in the current working directory.

Supported file names:

- `screensnip.config.json`
- `.screensniprc.json`
- `.screensniprc`

Example:

```json
{
	"port": 3000,
	"pageLoadTimeoutMs": 60000,
	"devUrlTimeoutMs": 90000,
	"waitForTimeout": 15000,
	"streamPollMs": 700,
	"minIntervalMs": 1200,
	"debounceMs": 300,
	"maxHistory": 5,
	"latestName": "latest.png"
}
```

Command-line flags always override config file values.

## Stream Mode Behavior

- Polls and reloads target page continuously.
- Detects rerenders by page signature changes.
- Debounces rapid updates and enforces a minimum capture interval.
- Saves rolling history as `stream-000001.png`, `stream-000002.png`, etc.
- Updates `latest.png` on each capture.
- Deletes oldest files once `--maxHistory` is exceeded.
- Waits for stable states before capture (`readyState`, load state, best-effort network idle).
- If a page returns a 404 or other HTTP error, the response is logged and the page can still be captured.
- Use `--browserConsole` to mirror browser console output, page errors, and failed requests into the CLI.

## Key Options

- `--stream`
- `--live` (alias for `--stream`)
- `--streamPoll <ms>`
- `--debounce <ms>`
- `--minInterval <ms>`
- `--maxHistory <count>`
- `--latestName <file>`
- `--stableWait <ms>`
- `--outDir <dir>`
- `--folderName <name>`
- `--browserConsole`
- `--config <file>`

Run `--help` for the full option set.

## API and Command Module Contract

Command modules can export `default` or `run` async function and receive:

`{ page, context, browser, baseUrl, outDir, playwright, options, helpers, log }`

## NPM Package Name

This repository is configured as the npm package `screensnip`.
