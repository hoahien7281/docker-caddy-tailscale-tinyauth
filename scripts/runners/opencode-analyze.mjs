#!/usr/bin/env node
// CI: ask opencode to inspect collected logs, env keys, and source code.
//
// Usage: node scripts/runners/opencode-analyze.mjs [--dry-run] [--silent]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { envGet, envKeys } from "../lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const LOG_DIR = resolve(ROOT, "ci-logs");
const ANALYSIS_DIR = resolve(LOG_DIR, "analysis");
const CONFIG_FILE = resolve(__dirname, "opencode-analyze-config.jsonc");
const PROMPT_FILE = resolve(ANALYSIS_DIR, "opencode-prompt.md");
const REPORT_FILE = resolve(ANALYSIS_DIR, "opencode-report.md");
const RAW_FILE = resolve(ANALYSIS_DIR, "opencode-raw-output.log");
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;
const ENV_FILE = resolve(ROOT, ".env");

process.chdir(ROOT);

function loadConfig() {
  const defaults = {
    timeout_ms: 600000,
    services: ["caddy", "tinyauth", "whoami", "cloudflared", "tailscale"],
    code_files: [
      "docker-compose.yml",
      "docker-compose.ci.yml",
      "networks/networks.yml",
      "caddy/caddy.yml",
      "tinyauth/tinyauth.yml",
      "whoami/whoami.yml",
      "cloudflare/cloudflare.yml",
      "tailscale/tailscale.yml",
      ".github/workflows/test.yml",
      "scripts/runners/setup-env.mjs",
      "scripts/runners/start-stack.mjs",
      "scripts/runners/collect-logs.mjs",
      "scripts/wait-and-test.mjs",
    ],
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

const config = loadConfig();

function readMaybe(path, limit = 12000) {
  if (!existsSync(path)) return "";
  const value = readFileSync(path, "utf8");
  return value.length > limit ? `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]` : value;
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (base) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const full = join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(ROOT, full).replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return out.sort();
}

function envSummary() {
  const keys = envKeys(ENV_FILE);
  const important = [
    "COMPOSE_PROFILES",
    "CF_TUNNEL_TOKEN",
    "WHOAMI_HOST",
    "DOMAIN",
    "TINYAUTH_APPURL",
    "TINYAUTH_AUTH_USERS",
    "TINYAUTH_AUTH_SECURECOOKIE",
    "CADDY_HTTP_PORT",
  ];
  const masked = important
    .filter((key) => keys.includes(key))
    .map((key) => `- ${key}: ${envGet(ENV_FILE, key) ? `set (${envGet(ENV_FILE, key).length} chars)` : "empty"}`);
  return [
    `Env file exists: ${existsSync(ENV_FILE)}`,
    `Keys: ${keys.join(", ") || "(none)"}`,
    "",
    "Important keys, masked:",
    masked.join("\n") || "(none)",
  ].join("\n");
}

function buildPrompt() {
  const logFiles = listFiles(LOG_DIR);
  const codeRefs = config.code_files.filter((file) => existsSync(resolve(ROOT, file)));
  const collectedLogs = logFiles
    .filter((file) => /(^ci-logs\/MANIFEST|compose-ps|public-url|all-services|services\/.*\.log$|inspect\/.*\.json$)/.test(file))
    .slice(0, 40)
    .map((file) => `## ${file}\n\`\`\`\n${readMaybe(resolve(ROOT, file), 16000)}\n\`\`\``)
    .join("\n\n");

  return `You are opencode running inside a GitHub Actions workflow for this repository.

Goal: produce a separate, complete failure-analysis report for this exact workflow run.

You MUST inspect the codebase and logs, not only this prompt:
- Read ci-logs/**, especially MANIFEST.txt, compose-ps.txt, compose-config.yml, all-services.log, services/*.log, inspect/*.json.
- Read these source/config files when relevant: ${codeRefs.join(", ")}.
- Inspect .env only as configuration evidence. Never print secret values. Print env key names and masked lengths only.
- Correlate Docker status, service logs, Compose config, workflow steps, env config, and source files.

Report requirements:
- Write final markdown to ci-logs/analysis/opencode-report.md.
- Include: run status, failing/passing services, detected errors, suspected root cause, exact evidence from logs, file:line references in code/config, wrong/missing env keys, and concrete fix steps.
- If no failure is found, still explain what was checked and why the run looks healthy.
- Do not suggest broad rewrites. Prefer the smallest config/code fix.
- Do not print secrets, tokens, cookies, hashes, or raw .env values.

Known project rules:
- Quick tunnel mode has no CF_TUNNEL_TOKEN and uses docker-compose.ci.yml.
- Named tunnel mode has CF_TUNNEL_TOKEN and public hostnames.
- Tinyauth v5 rejects unknown TINYAUTH_* and empty optional TINYAUTH_* keys.
- Smoke tests must not use curl -L; 200/301/302/307/401/403 prove external reachability.
- Quick tunnel CI must disable tinyauth_forwarder on whoami.

Collected file list:
\`\`\`
${logFiles.join("\n") || "(ci-logs missing)"}
\`\`\`

Masked env summary:
\`\`\`
${envSummary()}
\`\`\`

Collected log/config excerpts:
${collectedLogs || "(no collected logs found)"}
`;
}

function findOpencode() {
  const commands = process.platform === "win32"
    ? [["where.exe", ["opencode"]]]
    : [["bash", ["-lc", "command -v opencode"]]];
  for (const [cmd, cmdArgs] of commands) {
    try {
      const found = execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim().split(/\r?\n/)[0];
      if (found) return found;
    } catch {}
  }
  return "";
}

function writeFallbackReport(title, body) {
  const report = [
    "# Opencode CI Analysis Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Status: ${title}`,
    "",
    body,
    "",
    "## Available Evidence",
    "",
    `- Logs directory: ${existsSync(LOG_DIR) ? "present" : "missing"}`,
    `- Prompt file: ${relative(ROOT, PROMPT_FILE).replaceAll("\\", "/")}`,
    `- Env: ${envSummary().replace(/\n/g, "\n  ")}`,
  ].join("\n");
  writeFileSync(REPORT_FILE, report);
  return report;
}

function appendSummary(text) {
  if (!SUMMARY_FILE) return;
  try {
    writeFileSync(SUMMARY_FILE, text, { flag: "a" });
  } catch {}
}

async function runOpencode(opencodePath) {
  const shortPrompt = "Analyze this CI run. Read the attached prompt and repository files. Write the final markdown report to ci-logs/analysis/opencode-report.md.";
  return new Promise((resolve) => {
    const proc = spawn(opencodePath, ["run", "--auto", "--file", PROMPT_FILE, shortPrompt], {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      stderr += `\n[TIMEOUT] opencode exceeded ${config.timeout_ms}ms\n`;
    }, config.timeout_ms);

    proc.stdout.on("data", (data) => {
      const value = data.toString();
      stdout += value;
      if (!SILENT) process.stdout.write(value);
    });
    proc.stderr.on("data", (data) => {
      const value = data.toString();
      stderr += value;
      if (!SILENT) process.stderr.write(value);
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  mkdirSync(ANALYSIS_DIR, { recursive: true });
  const prompt = buildPrompt();
  writeFileSync(PROMPT_FILE, prompt);
  log(`Prompt saved: ${PROMPT_FILE}`);

  if (DRY_RUN) {
    log(`[DRY RUN] Would run opencode run --auto --file ${PROMPT_FILE}`);
    return;
  }

  const opencodePath = findOpencode();
  if (!opencodePath) {
    writeFallbackReport("opencode not found", "The opencode CLI was not available in PATH, so agent analysis could not run.");
    appendSummary("\n## Opencode Analysis\n\nopencode not found. Fallback report written to `ci-logs/analysis/opencode-report.md`.\n");
    return;
  }

  log(`opencode: ${opencodePath}`);
  const result = await runOpencode(opencodePath);
  const raw = [
    `exit_code=${result.code}`,
    "",
    "===== stdout =====",
    result.stdout || "(empty)",
    "",
    "===== stderr =====",
    result.stderr || "(empty)",
  ].join("\n");
  writeFileSync(RAW_FILE, raw);

  if (!existsSync(REPORT_FILE) || readFileSync(REPORT_FILE, "utf8").trim() === "") {
    writeFallbackReport(
      `opencode exited ${result.code}`,
      [
        "opencode did not create `ci-logs/analysis/opencode-report.md`; captured stdout/stderr below.",
        "",
        "## opencode stdout",
        "```",
        result.stdout.slice(0, 20000) || "(empty)",
        "```",
        "",
        "## opencode stderr",
        "```",
        result.stderr.slice(0, 20000) || "(empty)",
        "```",
      ].join("\n"),
    );
  }

  appendSummary("\n## Opencode Analysis\n\nReport: `ci-logs/analysis/opencode-report.md`\nRaw output: `ci-logs/analysis/opencode-raw-output.log`\n");
}

main().catch((error) => {
  mkdirSync(ANALYSIS_DIR, { recursive: true });
  writeFallbackReport("runner fatal error", error.stack || error.message);
  console.error(error.stack || error.message);
  process.exit(1);
});
