#!/usr/bin/env node
// scripts/addapp/app-utils.mjs
// Shared helpers for adding/validating user apps in the stack.
//
// Centralises:
//   - name / prefix normalisation (folder name ↔ ENV prefix)
//   - apps-config.jsonc read/write (the app registry)
//   - the allow-list of shared (non-prefixed) env keys an app may reference
//
// Used by:
//   scripts/addapp/add-app.mjs        (scaffold a new app)
//   scripts/addapp/validate-app.mjs   (check apps comply with the rules)
//   scripts/addapp/gen-app-ci.mjs     (generate app CI steps)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..", "..");
export const APPS_CONFIG = resolve(ROOT, "scripts/addapp/apps-config.jsonc");

// App types we support scaffolding for.
export const APP_TYPES = ["image", "dockerfile", "npx", "code"];

// Shared env keys any app is allowed to reference WITHOUT its own prefix.
// Everything else in <app>/.env.example MUST start with the app's prefix.
export const SHARED_ENV_KEYS = new Set([
  "DOMAIN",
  "COMPOSE_PROFILES",
  "DOCKER_VOLUME_DATA",
  "DOCKER_VOLUME_RUNTIME",
  "DOCKER_VOLUME_DATA_ABS",
  "DOCKER_VOLUME_RUNTIME_ABS",
]);

// Shared env key PREFIXES an app may reference (infra namespaces).
// e.g. CADDY_<APP>_HOST label override, TINYAUTH_* for auth.
export const SHARED_ENV_PREFIXES = ["CADDY_", "TINYAUTH_"];

/**
 * Normalise a raw app name to the canonical folder/service name.
 * Lowercases, replaces spaces/dots with underscore, strips invalid chars.
 * "Nine Router" / "nine-router" / "NineRouter" → "nine_router" (kebab kept if given).
 * We keep hyphens/underscores as-is if already valid; only clean the rest.
 */
export function normaliseName(raw) {
  return String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_") // spaces, dots, etc → _
    .replace(/^[_-]+|[_-]+$/g, "") // trim leading/trailing separators
    .replace(/_{2,}/g, "_");
}

/**
 * Derive the ENV prefix from a name.
 * Both "-" and "_" become "_"; UPPERCASED.
 * "nine_router" / "nine-router" → "NINE_ROUTER"
 */
export function nameToPrefix(name) {
  return normaliseName(name).replace(/-/g, "_").toUpperCase();
}

/**
 * Derive a Caddy-safe subdomain slug from a name (no underscores in hostnames).
 * "nine_router" → "nine-router"
 */
export function nameToSlug(name) {
  return normaliseName(name).replace(/_/g, "-");
}

/**
 * Whether an env key is allowed to be non-prefixed for a given app prefix.
 */
export function isAllowedEnvKey(key, appPrefix) {
  if (key.startsWith(`${appPrefix}_`)) return true;
  if (SHARED_ENV_KEYS.has(key)) return true;
  return SHARED_ENV_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Load the apps registry. Returns { apps: [...] } (empty list if missing).
 */
export function loadApps() {
  const defaults = { apps: [] };
  if (!existsSync(APPS_CONFIG)) return defaults;
  try {
    const parsed = parse(readFileSync(APPS_CONFIG, "utf8"));
    return { ...defaults, ...(parsed || {}) };
  } catch {
    return defaults;
  }
}

/**
 * Append a new app entry to apps-config.jsonc, preserving the header comment.
 * Rewrites the file as pretty JSON with a short generated-header note.
 * Returns the full updated apps array.
 */
export function addAppToConfig(entry) {
  const cfg = loadApps();
  if (cfg.apps.some((a) => a.name === entry.name)) {
    throw new Error(`App "${entry.name}" already registered in apps-config.jsonc`);
  }
  cfg.apps.push(entry);
  writeAppsConfig(cfg.apps);
  return cfg.apps;
}

/**
 * Persist the apps array back to apps-config.jsonc (keeps the doc header).
 */
export function writeAppsConfig(apps) {
  const header = `{
  // =========================================================================
  // apps-config.jsonc — central registry of user apps added to the stack
  // (edited by scripts/addapp/add-app.mjs — see scripts/addapp/app-utils.mjs)
  //
  // Entry schema: { name, prefix, type, port, auth, build? }
  //   build = { context, dockerfile, image, scope }  (only when a Dockerfile is built)
  // =========================================================================
  "apps": ${JSON.stringify(apps, null, 4).replace(/\n/g, "\n  ")},
}
`;
  writeFileSync(APPS_CONFIG, header);
}

/**
 * Return only apps that require a Docker build (have a "build" block).
 */
export function buildableApps() {
  return loadApps().apps.filter((a) => a && a.build && a.build.dockerfile);
}
