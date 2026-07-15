#!/usr/bin/env node
// scripts/wait-and-test.mjs
// CI: wait for services, discover public URL, verify external access.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker, dockerCmd } from "./runners/_docker.mjs";
import { envGet } from "./lib/env-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
process.chdir(ROOT);

const docker = detectDocker();
if (!docker.available) { console.error("ERROR: Docker not found."); process.exit(1); }

const ENV = resolve(ROOT, ".env");

const TIMEOUT = parseInt(process.env.TEST_TIMEOUT || "180", 10);
const INTERVAL = 5;
const ACCEPT_RE = /^(200|301|302|307|401|403)$/;

function sh(cmd) {
  try { return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim(); }
  catch { return ""; }
}

function httpCode(url) {
  try {
    const code = execSync(`curl -sS -o /tmp/proxy-stack-body.txt -w '%{http_code}' --max-time 20 "${url}"`, {
      cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], timeout: 25000,
    }).toString().trim();
    return /^\d{3}$/.test(code) ? code : "000";
  } catch { return "000"; }
}

// ── Wait for core containers ─────────────────────────────────────
console.log("==> Waiting for core containers...");
const start = Date.now();
const deadline = start + TIMEOUT * 1000;
while (Date.now() < deadline) {
  const running = sh(dockerCmd("compose ps --status running --services"));
  if (["caddy", "whoami", "cloudflared"].every((s) => running.split("\n").includes(s))) {
    console.log("    caddy, whoami, cloudflared are running");
    break;
  }
  execSync(`sleep ${INTERVAL}`, { stdio: "ignore" });
}

const running = sh(dockerCmd("compose ps --status running --services"));
const missing = ["caddy", "whoami", "cloudflared"].filter((s) => !running.split("\n").includes(s));
if (missing.length > 0) {
  console.error(`ERROR: required services not running: ${missing.join(", ")}`);
  try { execSync(dockerCmd("compose ps -a"), { stdio: "inherit", cwd: ROOT }); } catch {}
  for (const svc of missing) {
    console.error(`--- logs: ${svc} ---`);
    try { execSync(dockerCmd(`compose logs --no-color --tail=80 ${svc}`), { stdio: "inherit", cwd: ROOT }); } catch {}
  }
  process.exit(1);
}

// ── Probe local Caddy ────────────────────────────────────────────
console.log("==> Probing local Caddy (host port)...");
let localOk = false;
for (const port of [8080, 80]) {
  for (let i = 0; i < 24; i++) {
    const code = httpCode(`http://127.0.0.1:${port}/`);
    if (ACCEPT_RE.test(code)) {
      console.log(`    localhost:${port} → HTTP ${code}`);
      localOk = true;
      break;
    }
    execSync("sleep 2", { stdio: "ignore" });
  }
  if (localOk) break;
}
if (!localOk) {
  console.log("WARN: local Caddy not ready on :8080/:80 (continuing with public tunnel check)");
  try { execSync(dockerCmd("compose logs --no-color --tail=60 caddy"), { stdio: "inherit", cwd: ROOT }); } catch {}
  try { execSync(dockerCmd("compose logs --no-color --tail=40 whoami"), { stdio: "inherit", cwd: ROOT }); } catch {}
}

// ── Discover public URL ──────────────────────────────────────────
let publicUrl = process.env.PUBLIC_URL || "";

if (!publicUrl) {
  const tunnelToken = envGet(ENV, "CF_TUNNEL_TOKEN");
  const whoamiHost = envGet(ENV, "WHOAMI_HOST");
  const domain = envGet(ENV, "DOMAIN");

  if (tunnelToken) {
    if (whoamiHost) {
      publicUrl = whoamiHost.replace(/^http:\/\//, "https://");
      if (!publicUrl.startsWith("https://") && !publicUrl.startsWith("http://")) {
        publicUrl = `https://${publicUrl}`;
      }
    } else if (domain) {
      publicUrl = `https://whoami.${domain}`;
    }
    console.log(`==> Named tunnel mode → testing ${publicUrl || "(unset)"}`);
  }
}

if (!publicUrl) {
  console.log("==> Extracting Cloudflare quick-tunnel URL...");
  const cfExtract = resolve(ROOT, "cloudflare/scripts/extract-tunnel-url.mjs");
  if (existsSync(cfExtract)) {
    const extractTimeout = Math.min(TIMEOUT, 120);
    try {
      publicUrl = execSync(`node "${cfExtract}" ${extractTimeout} ${INTERVAL}`, {
        cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], timeout: (extractTimeout + 10) * 1000,
      }).toString().trim();
    } catch {
      console.error("ERROR: failed to extract trycloudflare.com URL");
      try { execSync(dockerCmd("compose logs --no-color cloudflared"), { stdio: "inherit", cwd: ROOT }); } catch {}
      process.exit(1);
    }
  } else {
    console.error(`ERROR: missing ${cfExtract}`);
    process.exit(1);
  }
}

if (!publicUrl) {
  console.error("ERROR: could not determine PUBLIC_URL");
  try { execSync(dockerCmd("compose logs --no-color cloudflared"), { stdio: "inherit", cwd: ROOT }); } catch {}
  try { execSync(dockerCmd("compose logs --no-color --tail=80 caddy"), { stdio: "inherit", cwd: ROOT }); } catch {}
  process.exit(1);
}

// ── Verify external HTTP access ──────────────────────────────────
console.log(`==> Public URL: ${publicUrl}`);
console.log("==> Verifying external HTTP access (no redirect follow)...");

let extOk = false;
let lastCode = "000";
for (let i = 1; i <= 36; i++) {
  lastCode = httpCode(`${publicUrl}/`);
  console.log(`    attempt ${i}: HTTP ${lastCode}`);
  if (ACCEPT_RE.test(lastCode)) { extOk = true; break; }

  // Debug probe at attempts 6 and 18
  if (i === 6 || i === 18) {
    console.log("    (debug) probe http://caddy:80 from proxy network:");
    try {
      execSync(dockerCmd('run --rm --network proxy curlimages/curl:8.5.0 -sS -o /dev/null -w "caddy_origin HTTP %{http_code}\\n" --max-time 10 http://caddy:80/'), { stdio: "inherit", cwd: ROOT });
    } catch { console.log("    (debug) origin probe failed"); }
  }
  execSync("sleep 5", { stdio: "ignore" });
}

if (!extOk) {
  console.error(`ERROR: public URL did not become reachable (last HTTP ${lastCode})`);
  try { execSync(dockerCmd("compose logs --no-color cloudflared"), { stdio: "inherit", cwd: ROOT }); } catch {}
  try { execSync(dockerCmd("compose logs --no-color --tail=100 caddy"), { stdio: "inherit", cwd: ROOT }); } catch {}
  try { execSync(dockerCmd("compose logs --no-color --tail=50 whoami"), { stdio: "inherit", cwd: ROOT }); } catch {}
  try { execSync(dockerCmd("compose logs --no-color --tail=40 tinyauth"), { stdio: "inherit", cwd: ROOT }); } catch {}
  process.exit(1);
}

console.log("");
console.log("SUCCESS: stack is reachable from the outside");
console.log(`  URL:  ${publicUrl}`);
console.log(`  HTTP: ${lastCode}`);

if (existsSync("/tmp/proxy-stack-body.txt")) {
  const body = readFileSync("/tmp/proxy-stack-body.txt", "utf8").split("\n").slice(0, 20).join("\n");
  console.log("  Body (first 20 lines):");
  console.log(body);
}

writeFileSync("/tmp/proxy-stack-public-url.txt", publicUrl);
writeFileSync(resolve(ROOT, "public-url.txt"), publicUrl);
