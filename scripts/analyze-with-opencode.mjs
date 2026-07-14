#!/usr/bin/env node
// scripts/analyze-with-opencode.mjs
// Run opencode to analyze CI logs locally.
//
// Usage: node scripts/analyze-with-opencode.mjs [ci-logs-dir]
//
// Checks if opencode CLI is available, then runs analysis.
// If not available, prints instructions for manual analysis.
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LOG_DIR = process.argv[2] || resolve(ROOT, "ci-logs");

process.chdir(ROOT);

console.log("🔍 Checking for opencode CLI...");

// Check if opencode is available
let opencodeAvailable = false;
try {
  execSync("opencode --version", { stdio: "ignore" });
  opencodeAvailable = true;
} catch {}

if (!opencodeAvailable) {
  console.log("❌ opencode CLI not found.");
  console.log("");
  console.log("Install opencode:");
  console.log("  npm install -g opencode");
  console.log("  # or");
  console.log("  brew install opencode");
  console.log("");
  console.log("Then run manually:");
  console.log(`  opencode "Analyze CI logs in ${LOG_DIR}. Check for errors, suggest improvements."`);
  process.exit(0);
}

console.log("✅ opencode found. Starting analysis...");
console.log("");

// Prepare the prompt
const prompt = `
Analyze the CI logs in ${LOG_DIR} directory.

Tasks:
1. Read all log files in services/ subdirectory
2. Check for errors, warnings, and anomalies
3. Identify performance bottlenecks
4. Suggest specific improvements for:
   - Build speed
   - Reliability
   - Configuration
   - Security
5. If errors found, analyze source code and suggest fixes

Output a structured report with:
- Summary of findings
- Critical issues (if any)
- Improvement recommendations
- Specific file/line references for fixes
`.trim();

// Run opencode
try {
  // Write prompt to temp file to avoid shell escaping issues
  const tempFile = resolve(ROOT, ".opencode-prompt.txt");
  writeFileSync(tempFile, prompt);
  
  console.log("Prompt saved to:", tempFile);
  console.log("");
  console.log("opencode is an interactive tool - cannot run in CI/CD.");
  console.log("");
  console.log("To analyze logs with opencode, run locally:");
  console.log("  1. Download the logs artifact from GitHub Actions");
  console.log("  2. Extract to ci-logs/ directory");
  console.log("  3. Run: opencode");
  console.log("  4. Paste the prompt from:", tempFile);
  console.log("");
  console.log("Or use the automated analysis:");
  console.log("  node scripts/runners/analyze-workflow.mjs");
  
  // Clean up
  try {
    unlinkSync(tempFile);
  } catch {}
} catch (e) {
  console.error("Error:", e.message);
  process.exit(1);
}