#!/usr/bin/env node
// scripts/addapp/validate-app.mjs
// Validate that an app (or all registered apps) complies with the stack rules
// documented in docs/ADDING_APPS.md.
//
// Usage:
//   node scripts/addapp/validate-app.mjs                # validate ALL registered apps
//   node scripts/addapp/validate-app.mjs nine-router    # validate one app
//   node scripts/addapp/validate-app.mjs --json         # machine-readable output (CI)
//
// Flags:
//   --json      Print a JSON report ({ ok, apps: [...] }) instead of text.
//   --dry-run   No-op here (read-only) but accepted for consistency.
//   --silent    Suppress console output (exit code still reflects result).
//
// Exit code: 0 = all pass, 1 = any failure.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ROOT, loadApps, normaliseName, nameToPrefix, isAllowedEnvKey,
} from "./app-utils.mjs";
import { envKeys } from "../lib/env-utils.mjs";

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const SILENT = argv.includes("--silent") || JSON_OUT;
const log = (...a) => { if (!SILENT) console.log(...a); };
const targetName = argv.find((a) => !a.startsWith("--"));

const registered = loadApps().apps;

// Which apps to check: explicit target, else every registered app.
let apps;
if (targetName) {
  const n = normaliseName(targetName);
  const found = registered.find((a) => a.name === n);
  apps = found ? [found] : [{ name: n, prefix: nameToPrefix(n), _unregistered: true }];
} else {
  apps = registered;
}

function checkApp(app) {
  const errors = [];
  const warnings = [];
  const passed = [];
  const name = app.name;
  const prefix = app.prefix || nameToPrefix(name);
  const dir = resolve(ROOT, name);
  const yml = resolve(dir, `${name}.yml`);
  const envExample = resolve(dir, ".env.example");

  const ok = (m) => passed.push(m);
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);

  // 0. Registered in apps-config.jsonc
  if (app._unregistered) err("not registered in scripts/addapp/apps-config.jsonc (run add-app.mjs)");
  else ok("registered in apps-config.jsonc");

  // 1. Directory + correctly named compose file
  if (!existsSync(dir)) { err(`directory ${name}/ missing`); return finalize(); }
  if (!existsSync(yml)) err(`compose file ${name}/${name}.yml missing (must be <service>/<service>.yml)`);
  else ok(`compose file named ${name}/${name}.yml`);

  const ymlText = existsSync(yml) ? readFileSync(yml, "utf8") : "";

  // 2. Header comment
  if (ymlText.startsWith("# =")) ok("has header comment");
  else if (ymlText) warn("compose file should start with a `# ===` header comment");

  // 3. profiles present (own name + full)
  if (/\bprofiles:/.test(ymlText)) {
    ok("has profiles");
    if (!new RegExp(`- ${name}\\b`).test(ymlText)) err(`profiles must include own name "${name}"`);
    else ok(`profile includes own name "${name}"`);
  } else err("missing profiles: (every app must be profile-gated)");

  // 4. attached to proxy network
  if (/networks:\s*[\s\S]*?- proxy/.test(ymlText) || /- proxy\b/.test(ymlText)) ok("attached to proxy network");
  else err("must attach to the shared `proxy` network");

  // 5. env_file wiring
  if (/env_file:/.test(ymlText) && /\.\.\/\.env/.test(ymlText)) ok("loads root + local env_file");
  else warn("should load env_file ../.env and ./.env");

  // 6. Caddy label host
  if (/caddy:\s*\$\{/.test(ymlText)) ok("has Caddy host label");
  else warn("no Caddy host label found — app will not be routed");

  // 7. No empty optional environment injection: KEY: ${KEY:-}
  const emptyInject = ymlText.match(/^\s+[A-Z0-9_]+:\s*\$\{[A-Z0-9_]+:-\}\s*$/gm);
  if (emptyInject) err(`empty-string env injection found (KEY: \${KEY:-}) — remove: ${emptyInject.map(s=>s.trim()).join(" | ")}`);
  else ok("no empty-string env injection");

  // 8. Volumes under DOCKER_VOLUME_* roots
  const volLines = (ymlText.match(/^\s+-\s+.*:.*$/gm) || []).filter((l) => /volumes:/.test(ymlText) && l.includes(":/") );
  // Heuristic: any bind that writes app data should use the shared roots.
  if (/DOCKER_VOLUME_(DATA|RUNTIME)_ABS/.test(ymlText)) ok("data volume under DOCKER_VOLUME_* root");
  else if (/volumes:/.test(ymlText)) warn("volumes present but none use DOCKER_VOLUME_DATA/RUNTIME roots");

  // 9. Registered in root docker-compose.yml include
  const rootCompose = resolve(ROOT, "docker-compose.yml");
  if (existsSync(rootCompose)) {
    const inc = readFileSync(rootCompose, "utf8");
    if (inc.includes(`./${name}/${name}.yml`)) ok("registered in docker-compose.yml include");
    else err("not registered in docker-compose.yml include");
  }

  // 10. .env.example exists + prefix rule
  if (!existsSync(envExample)) {
    err(`${name}/.env.example missing`);
  } else {
    ok(`${name}/.env.example present`);
    const keys = envKeys(envExample);
    const bad = keys.filter((k) => !isAllowedEnvKey(k, prefix));
    if (bad.length) err(`env keys must be prefixed "${prefix}_" (offending: ${bad.join(", ")})`);
    else ok(`all env keys use prefix "${prefix}_" (or allowed shared keys)`);
  }

  // 11. Build type consistency
  if (app.build) {
    if (!existsSync(resolve(ROOT, name, "Dockerfile"))) err(`type "${app.type}" declares a build but ${name}/Dockerfile is missing`);
    else ok("Dockerfile present for build");
    if (existsSync(rootCompose)) {
      // ensure cache scope registered
      const cacheCfg = resolve(ROOT, "scripts/addapp/apps-config.jsonc");
      const c = existsSync(cacheCfg) ? readFileSync(cacheCfg, "utf8") : "";
      if (app.build.scope && c.includes(`"scope": "${app.build.scope}"`)) ok(`buildx cache scope "${app.build.scope}" registered`);
    }
  }

  function finalize() {
    return { name, prefix, type: app.type, ok: errors.length === 0, errors, warnings, passed };
  }
  return finalize();
}

const results = apps.map(checkApp);
const allOk = results.every((r) => r.ok);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ ok: allOk, apps: results }, null, 2) + "\n");
} else {
  if (apps.length === 0) log("No apps registered yet. Add one with: node scripts/addapp/add-app.mjs --name <n> --type <t>");
  for (const r of results) {
    log(`\n=== ${r.name} (${r.type || "?"}) — ${r.ok ? "PASS ✅" : "FAIL ❌"} ===`);
    r.passed.forEach((m) => log(`  ✔ ${m}`));
    r.warnings.forEach((m) => log(`  ⚠ ${m}`));
    r.errors.forEach((m) => log(`  ✘ ${m}`));
  }
  log(`\n${allOk ? "All apps valid ✅" : "Validation FAILED ❌"}`);
}

process.exit(allOk ? 0 : 1);
