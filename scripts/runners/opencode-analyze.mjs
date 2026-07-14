#!/usr/bin/env node
// scripts/runners/opencode-analyze.mjs
// Run opencode agent to analyze CI logs and source code.
//
// Usage: node scripts/runners/opencode-analyze.mjs [--dry-run] [--silent]
//
// Env vars: GITHUB_STEP_SUMMARY, GITHUB_WORKSPACE.
import { execSync, spawn } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const LOG_DIR = resolve(ROOT, "ci-logs");
const ANALYSIS_DIR = resolve(LOG_DIR, "analysis");
const GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;

process.chdir(ROOT);

// Ensure analysis directory exists
mkdirSync(ANALYSIS_DIR, { recursive: true });

// Build comprehensive prompt for opencode
function buildPrompt() {
  // Gather context about the project
  const services = ["caddy", "tinyauth", "whoami", "cloudflared", "tailscale"];
  
  // Read key config files
  let dockerCompose = "";
  try { dockerCompose = readFileSync(resolve(ROOT, "docker-compose.yml"), "utf8").substring(0, 2000); } catch {}
  
  let envCi = "";
  try { envCi = readFileSync(resolve(ROOT, ".env.ci"), "utf8").substring(0, 1000); } catch {}
  
  // Gather log summaries
  const logSummaries = [];
  for (const svc of services) {
    const logFile = resolve(LOG_DIR, `services/${svc}.log`);
    if (existsSync(logFile)) {
      const content = readFileSync(logFile, "utf8");
      // Get last 50 lines and any error lines
      const lines = content.split("\n");
      const errors = lines.filter(l => /error|fatal|panic|failed|exception/i.test(l)).slice(0, 10);
      const tail = lines.slice(-50).join("\n");
      logSummaries.push(`### ${svc} log (${lines.length} lines)\nErrors:\n${errors.join("\n") || "(none)"}\nTail:\n\`\`\`\n${tail}\n\`\`\``);
    }
  }
  
  // Read all-services.log for cross-service issues
  let allLogs = "";
  try { allLogs = readFileSync(resolve(LOG_DIR, "all-services.log"), "utf8"); } catch {}
  const crossServiceErrors = allLogs.split("\n")
    .filter(l => /error|fatal|panic|failed|exception|refused|timeout/i.test(l))
    .slice(0, 20)
    .join("\n");

  return `You are analyzing a Docker Compose stack CI run. Your job is to provide a comprehensive analysis.

## Project Structure
This is a modular Docker reverse-proxy stack with: Cloudflare Tunnel, Tailscale, Caddy, Tinyauth, and a demo app (whoami).

## Key Files to Read
- docker-compose.yml (root join file)
- caddy/caddy.yml, tinyauth/tinyauth.yml, whoami/whoami.yml, cloudflare/cloudflare.yml, tailscale/tailscale.yml
- .env.ci (CI environment config)
- scripts/runners/*.mjs (CI scripts)
- AGENTS.md (project conventions)

## Your Tasks

1. **Read the source code**: Examine docker-compose files, service configs, and CI scripts to understand the architecture.

2. **Analyze logs**: Review the log summaries below and identify:
   - Error patterns and their root causes
   - Service dependency issues
   - Configuration problems
   - Performance bottlenecks

3. **Trace issues to source**: For each error found, trace it back to the specific file and line in the source code.

4. **Generate report**: Create a structured report with:
   - Executive summary (what happened in this CI run)
   - Critical issues with file:line references
   - Service-by-service analysis
   - Improvement recommendations with specific code changes
   - Risk assessment

## Log Summaries

### Cross-service errors:
${crossServiceErrors || "(none found)"}

${logSummaries.join("\n\n")}

## Docker Compose Config (truncated):
\`\`\`yaml
${dockerCompose}
\`\`\`

## CI Environment (.env.ci):
\`\`\`
${envCi}
\`\`\`

## Output Format
Write your analysis as a markdown report. Be specific with file paths and line numbers. Focus on actionable improvements.

When done, write the full report to ci-logs/analysis/opencode-report.md and summarize key findings.`;
}

// Main
async function main() {
  const prompt = buildPrompt();
  const promptFile = resolve(ROOT, ".opencode-prompt.md");
  const reportFile = resolve(ANALYSIS_DIR, "opencode-report.md");
  
  writeFileSync(promptFile, prompt);
  log("Prompt written to:", promptFile);
  log("Report will be saved to:", reportFile);
  
  if (DRY_RUN) {
    log("[DRY RUN] Would run opencode with prompt");
    log("[DRY RUN] Prompt length:", prompt.length, "chars");
    return;
  }
  
  // Check if opencode is available
  let opencodePath = "";
  try {
    opencodePath = execSync("where opencode 2>nul || which opencode 2>/dev/null", { encoding: "utf8" }).trim();
  } catch {
    log("WARN: opencode not found in PATH, skipping analysis");
    process.exit(0);
  }
  log("Found opencode at:", opencodePath);
  
  // Run opencode with timeout
  log("Starting opencode analysis (timeout: 5 minutes)...");
  
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
  
  return new Promise((resolve, reject) => {
    const proc = spawn(opencodePath, [], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: { ...process.env, FORCE_COLOR: "0" }
    });
    
    let stdout = "";
    let stderr = "";
    
    proc.stdout.on("data", (data) => {
      const str = data.toString();
      stdout += str;
      if (!SILENT) process.stdout.write(str);
    });
    
    proc.stderr.on("data", (data) => {
      const str = data.toString();
      stderr += str;
      if (!SILENT) process.stderr.write(str);
    });
    
    // Send prompt via stdin and close
    proc.stdin.write(prompt);
    proc.stdin.end();
    
    // Timeout
    const timer = setTimeout(() => {
      log("\n[TIMEOUT] Killing opencode after 5 minutes");
      proc.kill("SIGTERM");
    }, TIMEOUT_MS);
    
    proc.on("close", (code) => {
      clearTimeout(timer);
      log(`\nopencode exited with code ${code}`);
      
      // Save output to report file
      const report = `# Opencode CI Analysis Report
Generated: ${new Date().toISOString()}
Exit code: ${code}
Duration: ${Math.round((Date.now() - startTime) / 1000)}s

## opencode Output
${stdout || "(no output)"}

## Errors/Warnings
${stderr || "(none)"}
`;
      writeFileSync(reportFile, report);
      log("Report saved to:", reportFile);
      
      // Also append to GitHub Step Summary
      if (GITHUB_STEP_SUMMARY) {
        try {
          const summary = `## Opencode Analysis\n\nReport saved to \`ci-logs/analysis/opencode-report.md\`\n\n`;
          execSync(`cat >> "${GITHUB_STEP_SUMMARY}"`, { input: summary });
        } catch {}
      }
      
      resolve(code);
    });
    
    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error("Failed to start opencode:", err.message);
      reject(err);
    });
    
    const startTime = Date.now();
  });
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
