#!/usr/bin/env node
// cloudflare/scripts/extract-tunnel-url.mjs
// Print quick-tunnel URL (*.trycloudflare.com) from cloudflared logs.
// Exit 0 + URL on stdout when found; exit 1 if not found within timeout.
//
// Usage: node extract-tunnel-url.mjs [timeout] [interval]
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker, dockerCmd } from "../../scripts/runners/_docker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
process.chdir(ROOT);

const docker = detectDocker();
if (!docker.available) { console.error("ERROR: Docker not found."); process.exit(1); }

const TIMEOUT = parseInt(process.argv[2] || process.env.TEST_TIMEOUT || "120", 10);
const INTERVAL = parseInt(process.argv[3] || "5", 10);

function sh(cmd) {
  try { return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim(); }
  catch { return ""; }
}

const start = Date.now();
const deadline = start + TIMEOUT * 1000;

while (Date.now() < deadline) {
  const logs = sh(dockerCmd("compose logs --no-color --no-log-prefix cloudflared"));

  const match = logs.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  if (match) {
    console.log(match[0]);
    process.exit(0);
  }

  // Fail fast if named-tunnel mode detected
  if (/CF_TUNNEL_TOKEN|must specify|failed to create|error parsing tunnel|provided tunnel token/i.test(logs)) {
    if (!/trycloudflare|Requesting new quick Tunnel/i.test(logs)) {
      console.error("ERROR: cloudflared does not look like quick-tunnel mode (still named/token?)");
      console.error(logs.split("\n").slice(-40).join("\n"));
      process.exit(1);
    }
  }

  execSync(`sleep ${INTERVAL}`, { stdio: "ignore" });
}

console.error(`ERROR: no trycloudflare.com URL found in cloudflared logs within ${TIMEOUT}s`);
console.error("--- last cloudflared logs ---");
try { console.error(sh(dockerCmd("compose logs --no-color --tail=80 cloudflared"))); } catch {}
console.error("--- resolved command ---");
try { console.error(sh(dockerCmd("compose config")).split("\n").filter((l) => /cloudflared/.test(l)).slice(0, 10).join("\n")); } catch {}
process.exit(1);
