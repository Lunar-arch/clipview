import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const FRAMEWORKS = [
  {
    id: "next",
    name: "Next.js",
    defaultPort: 3000,
    preferredScript: "dev",
    fallbackCommand: "next dev",
    detect: (deps) => hasDependency(deps, "next"),
  },
  {
    id: "nuxt",
    name: "Nuxt",
    defaultPort: 3000,
    preferredScript: "dev",
    fallbackCommand: "nuxi dev",
    detect: (deps) => hasDependency(deps, "nuxt") || hasDependency(deps, "nuxi"),
  },
  {
    id: "sveltekit",
    name: "SvelteKit",
    defaultPort: 5173,
    preferredScript: "dev",
    fallbackCommand: "vite dev",
    detect: (deps) => hasDependency(deps, "@sveltejs/kit"),
  },
  {
    id: "astro",
    name: "Astro",
    defaultPort: 4321,
    preferredScript: "dev",
    fallbackCommand: "astro dev",
    detect: (deps) => hasDependency(deps, "astro"),
  },
  {
    id: "remix",
    name: "Remix",
    defaultPort: 3000,
    preferredScript: "dev",
    fallbackCommand: "remix dev",
    detect: (deps) => hasDependency(deps, "@remix-run/dev") || hasDependency(deps, "@remix-run/react"),
  },
  {
    id: "cra",
    name: "React (CRA)",
    defaultPort: 3000,
    preferredScript: "start",
    fallbackCommand: "react-scripts start",
    detect: (deps) => hasDependency(deps, "react-scripts"),
  },
  {
    id: "angular",
    name: "Angular",
    defaultPort: 4200,
    preferredScript: "start",
    fallbackCommand: "ng serve",
    detect: (deps) => hasDependency(deps, "@angular/core") || hasDependency(deps, "@angular/cli"),
  },
  {
    id: "solidstart",
    name: "SolidStart",
    defaultPort: 3000,
    preferredScript: "dev",
    fallbackCommand: "vite dev",
    detect: (deps) => hasDependency(deps, "@solidjs/start"),
  },
  {
    id: "qwik",
    name: "Qwik",
    defaultPort: 5173,
    preferredScript: "dev",
    fallbackCommand: "vite dev",
    detect: (deps) => hasDependency(deps, "@builder.io/qwik") || hasDependency(deps, "@qwikdev/qwik"),
  },
  {
    id: "vite-react",
    name: "Vite React",
    defaultPort: 5173,
    preferredScript: "dev",
    fallbackCommand: "vite dev",
    detect: (deps) => hasDependency(deps, "vite") && hasDependency(deps, "react"),
  },
  {
    id: "vite-vue",
    name: "Vite Vue",
    defaultPort: 5173,
    preferredScript: "dev",
    fallbackCommand: "vite dev",
    detect: (deps) => hasDependency(deps, "vite") && hasDependency(deps, "vue"),
  },
  {
    id: "vue-cli",
    name: "Vue CLI",
    defaultPort: 8080,
    preferredScript: "serve",
    fallbackCommand: "vue-cli-service serve",
    detect: (deps) => hasDependency(deps, "@vue/cli-service") || hasDependency(deps, "vue-cli-service"),
  },
  {
    id: "vite",
    name: "Vite",
    defaultPort: 5173,
    preferredScript: "dev",
    fallbackCommand: "vite dev",
    detect: (deps) => hasDependency(deps, "vite"),
  },
  {
    id: "react",
    name: "React",
    defaultPort: 3000,
    preferredScript: "dev",
    fallbackCommand: "vite dev",
    detect: (deps) => hasDependency(deps, "react"),
  },
  {
    id: "vue",
    name: "Vue",
    defaultPort: 5173,
    preferredScript: "dev",
    fallbackCommand: "vite dev",
    detect: (deps) => hasDependency(deps, "vue"),
  },
];

function hasDependency(deps, name) {
  return Object.prototype.hasOwnProperty.call(deps, name);
}

function getDependencies(packageJson) {
  return {
    ...(packageJson?.dependencies ?? {}),
    ...(packageJson?.devDependencies ?? {}),
  };
}

function detectFramework(packageJson) {
  const deps = getDependencies(packageJson);

  for (const framework of FRAMEWORKS) {
    if (framework.detect(deps)) {
      return framework;
    }
  }

  return {
    id: "generic",
    name: "Generic",
    defaultPort: 3000,
    preferredScript: "dev",
    fallbackCommand: "vite dev",
  };
}

function buildScriptCommand(packageManager, scriptName, port, frameworkId) {
  let baseCommand = "npm run dev";

  if (packageManager === "pnpm") {
    baseCommand = `pnpm run ${scriptName}`;
  } else if (packageManager === "yarn") {
    baseCommand = `yarn ${scriptName}`;
  } else if (packageManager === "bun") {
    baseCommand = `bun run ${scriptName}`;
  } else {
    baseCommand = `npm run ${scriptName}`;
  }

  if (!port) {
    return baseCommand;
  }

  // Only append explicit CLI port flags for frameworks known to honor them.
  const acceptsPortFlag = [
    "next",
    "nuxt",
    "sveltekit",
    "astro",
    "remix",
    "vite",
    "vite-react",
    "vite-vue",
    "angular",
    "solidstart",
    "qwik",
  ].includes(frameworkId);

  if (!acceptsPortFlag) {
    return baseCommand;
  }

  if (packageManager === "yarn") {
    return `${baseCommand} --port ${port}`;
  }

  return `${baseCommand} -- --port ${port}`;
}

function buildExecCommand(packageManager, command, port) {
  const portArg = port ? ` --port ${port}` : "";

  if (packageManager === "pnpm") {
    return `pnpm exec ${command}${portArg}`;
  }

  if (packageManager === "yarn") {
    return `yarn ${command}${portArg}`;
  }

  if (packageManager === "bun") {
    return `bunx ${command}${portArg}`;
  }

  return `npx ${command}${portArg}`;
}

function guessPackageManagerFromLockfile(projectDir) {
  const lockfiles = [
    { name: "pnpm-lock.yaml", pm: "pnpm" },
    { name: "yarn.lock", pm: "yarn" },
    { name: "bun.lockb", pm: "bun" },
    { name: "bun.lock", pm: "bun" },
    { name: "package-lock.json", pm: "npm" },
  ];

  for (const lockfile of lockfiles) {
    if (existsSync(path.join(projectDir, lockfile.name))) {
      return lockfile.pm;
    }
  }

  return null;
}

export function detectPackageManager(projectDir = process.cwd()) {
  const lockfilePm = guessPackageManagerFromLockfile(projectDir);
  if (lockfilePm) {
    return lockfilePm;
  }

  const userAgent = process.env.npm_config_user_agent ?? "";

  if (userAgent.startsWith("pnpm/")) {
    return "pnpm";
  }

  if (userAgent.startsWith("yarn/")) {
    return "yarn";
  }

  if (userAgent.startsWith("bun/")) {
    return "bun";
  }

  return "npm";
}

export async function loadProjectPackageJson(projectDir = process.cwd()) {
  const packageJsonPath = path.join(projectDir, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { packageJson: null, packageJsonPath };
  }

  const raw = await fs.readFile(packageJsonPath, "utf8");
  return {
    packageJson: JSON.parse(raw),
    packageJsonPath,
  };
}

export async function detectProjectContext(projectDir = process.cwd()) {
  const { packageJson, packageJsonPath } = await loadProjectPackageJson(projectDir);
  const framework = detectFramework(packageJson);
  const packageManager = detectPackageManager(projectDir);
  const scripts = packageJson?.scripts ?? {};

  return {
    projectDir,
    packageJson,
    packageJsonPath,
    packageManager,
    framework,
    scripts,
  };
}

export function inferPreferredScript(context) {
  const scripts = context?.scripts ?? {};
  const framework = context?.framework ?? { preferredScript: "dev", id: "generic" };

  if (typeof scripts.dev === "string") {
    return "dev";
  }

  if (framework.preferredScript && typeof scripts[framework.preferredScript] === "string") {
    return framework.preferredScript;
  }

  if (framework.id === "cra" && typeof scripts.start === "string") {
    return "start";
  }

  if (typeof scripts.start === "string") {
    return "start";
  }

  if (typeof scripts.serve === "string") {
    return "serve";
  }

  return null;
}

export function inferSuggestedPort(context, explicitPort = null) {
  if (explicitPort) {
    return explicitPort;
  }

  return context?.framework?.defaultPort ?? 3000;
}

export function inferDevCommand(context, options = {}) {
  const {
    configuredCommand = null,
    requestedPort = null,
  } = options;

  if (configuredCommand && configuredCommand.trim()) {
    return {
      command: configuredCommand.trim(),
      source: "configured",
      scriptName: null,
    };
  }

  const scriptName = inferPreferredScript(context);
  const port = inferSuggestedPort(context, requestedPort);

  if (scriptName) {
    return {
      command: buildScriptCommand(context.packageManager, scriptName, port, context.framework.id),
      source: "script",
      scriptName,
    };
  }

  if (context.framework.id === "generic") {
    return {
      command: buildScriptCommand(context.packageManager, "dev", port, context.framework.id),
      source: "generic-script-fallback",
      scriptName: "dev",
    };
  }

  return {
    command: buildExecCommand(context.packageManager, context.framework.fallbackCommand, port),
    source: "framework-fallback",
    scriptName: null,
  };
}
