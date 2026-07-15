#!/usr/bin/env node
// tinyauth/scripts/generate-user.mjs
// Generate bcrypt hash for TINYAUTH_AUTH_USERS — no Docker required.
//
// Usage:
//   node tinyauth/scripts/generate-user.mjs                    # interactive
//   node tinyauth/scripts/generate-user.mjs --silent -u user -p pass
//   node tinyauth/scripts/generate-user.mjs --dry-run          # show hash only
//   node tinyauth/scripts/generate-user.mjs --env path/to/.env # update TINYAUTH_AUTH_USERS in file
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const flagVal = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : ""; };
const cliUser = flagVal("-u");
const cliPass = flagVal("-p");
const envPath = flagVal("--env");

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans); }));
}

async function askSecret(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    process.stdout.write(question);
    let pw = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (ch) => {
      if (ch === "\n" || ch === "\r" || ch === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        rl.close();
        console.log();
        res(pw);
      } else if (ch === "\u0003") {
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        if (pw.length > 0) { pw = pw.slice(0, -1); process.stdout.write("\b \b"); }
      } else {
        pw += ch;
        process.stdout.write("*");
      }
    });
  });
}

async function hashBcrypt(pw) {
  try {
    const { default: bcryptjs } = await import("bcryptjs");
    return bcryptjs.hashSync(pw, 10);
  } catch {}
  try {
    const { execSync } = await import("node:child_process");
    return execSync(`openssl passwd -6 ${JSON.stringify(pw)}`).toString().trim();
  } catch {}
  return null;
}

if (!SILENT) console.log("=== Tinyauth user generator ===\n");

const user = (SILENT || DRY_RUN) && cliUser ? cliUser : await ask("Username: ");
if (!user) { console.error("ERROR: username cannot be empty"); process.exit(1); }

const pass = (SILENT || DRY_RUN) && cliPass ? cliPass : await askSecret("Password: ");
if (!pass) { console.error("ERROR: password cannot be empty"); process.exit(1); }

const hash = await hashBcrypt(pass);
if (!hash) {
  console.error("ERROR: no hash tool available. Install bcryptjs: npm install");
  process.exit(1);
}

const composeHash = hash.replace(/\$/g, "$$$$");
const entry = `TINYAUTH_AUTH_USERS=${user}:${composeHash}`;

function updateEnvFile(filePath, line) {
  const content = readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => /^TINYAUTH_AUTH_USERS\s*=/.test(l));
  if (idx !== -1) {
    lines[idx] = line;
  } else {
    let lastTinyauth = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^TINYAUTH_/.test(lines[i])) lastTinyauth = i;
    }
    if (lastTinyauth !== -1) {
      lines.splice(lastTinyauth + 1, 0, line);
    } else {
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(line);
    }
  }
  writeFileSync(filePath, lines.join("\n"));
}

if (DRY_RUN) {
  console.log(`[DRY RUN] ${user}:${hash}`);
  if (envPath) console.log(`[DRY RUN] Would update ${envPath}: ${entry}`);
  process.exit(0);
}

if (SILENT) {
  console.log(`${user}:${composeHash}`);
  if (envPath) updateEnvFile(envPath, entry);
  process.exit(0);
}

console.log(`
=== Result ===

Add to .env:
  TINYAUTH_AUTH_USERS=${user}:${composeHash}

Raw (for non-Compose use):
  ${user}:${hash}

If the hash contains $ characters, double them ($$) in .env
so Docker Compose keeps a single $ in the container.
`);

if (envPath) {
  updateEnvFile(envPath, entry);
  console.log(`Updated ${envPath}: TINYAUTH_AUTH_USERS=${user}:<hash>`);
}
