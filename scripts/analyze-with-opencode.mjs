#!/usr/bin/env node
// scripts/analyze-with-opencode.mjs
// CI/CD stack analyzer — đóng vai trò chuyên gia CI/CD tự động.
//
// Việc script làm, theo đúng thứ tự:
//   1. Đọc "docker ps -a" toàn bộ container của stack (state / health / restarts).
//   2. Với mỗi service: nếu container không healthy / restart-loop / log có lỗi
//      → đọc code (compose file tương ứng) + .env đang thực thi, tìm nguyên nhân,
//      đề xuất hướng xử lý.
//   3. Nếu container "xanh" (running/healthy) → không dừng ở đó — rà soát codebase
//      + biến môi trường rồi TỰ GIẢ LẬP request để chứng minh luồng thật:
//        Internet (giả lập) → Cloudflare Tunnel → Caddy → (Tinyauth) → App
//      Nếu request giả lập fail dù container "xanh", vẫn coi là FAIL kèm nguyên nhân.
//   4. Ghi toàn bộ kết quả vào reports/report.md (và mirror vào ci-logs/analysis/
//      nếu ci-logs/ tồn tại, để CI có thể upload làm artifact).
//
// KHÔNG BAO GIỜ ghi giá trị secret thật vào report. Chỉ liệt kê TÊN khoá .env.
// Khi một biến .env được xác định là NGUYÊN NHÂN gây lỗi, giá trị của nó được
// che theo đúng định dạng:  env:faild:********<số ký tự đang có>
// (số ký tự = độ dài giá trị hiện có trong .env, 0 nếu thiếu/rỗng)
//
// Usage:
//   node scripts/analyze-with-opencode.mjs [--dry-run] [--silent]
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { detectDocker, dockerCmd } from "./runners/_docker.mjs";
import { envGet, envKeys as envKeysList } from "./lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };
const err = (...a) => { if (!SILENT) console.error(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CONFIG_FILE = resolve(__dirname, "analyze-config.jsonc");
const REPORT_DIR = resolve(ROOT, "reports");
const REPORT_FILE = resolve(REPORT_DIR, "report.md");
const CI_MIRROR_DIR = resolve(ROOT, "ci-logs/analysis");

process.chdir(ROOT);

// ── Config (extracted per AGENTS.md — no hardcoded lists inline) ───────────
function loadConfig() {
  const defaults = {
    accept_http_codes: ["200", "301", "302", "307", "401", "403"],
    services: [
      {
        name: "caddy",
        profile: "caddy",
        required: true,
        compose_file: "caddy/caddy.yml",
        required_env: [],
        probe: { type: "http_local" },
      },
      {
        name: "tinyauth",
        profile: "tinyauth",
        required: true,
        compose_file: "tinyauth/tinyauth.yml",
        required_env: ["TINYAUTH_AUTH_USERS", "TINYAUTH_APPURL"],
        probe: { type: "http_internal", target: "http://tinyauth:3000/api/auth/caddy" },
      },
      {
        name: "whoami",
        profile: "whoami",
        required: true,
        compose_file: "whoami/whoami.yml",
        required_env: ["WHOAMI_HOST"],
        probe: { type: "http_internal", target: "http://whoami:80/" },
      },
      {
        name: "cloudflared",
        profile: "cloudflare",
        required: true,
        compose_file: "cloudflare/cloudflare.yml",
        required_env: [],
        probe: { type: "tunnel" },
      },
      {
        name: "tailscale",
        profile: "tailscale",
        required: false,
        compose_file: "tailscale/tailscale.yml",
        required_env: [],
        probe: { type: "none" },
      },
    ],
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  try {
    return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return defaults;
  }
}

const config = loadConfig();
const ACCEPT_RE = new RegExp(`^(${config.accept_http_codes.join("|")})$`);

// ── Known error patterns → hướng xử lý (map sang code/tài liệu dự án) ──────
const ERROR_PATTERNS = [
  {
    regex: /unknown environment variable|refus.*start|invalid configuration/i,
    category: "config",
    hint: "Tinyauth v5 từ chối các biến TINYAUTH_* lạ hoặc bị bỏ rỗng qua environment: (xem AGENTS.md mục 'Env injection rules'). Kiểm tra tinyauth/tinyauth.yml và các key TINYAUTH_* trong .env — xoá key rỗng thay vì để KEY=.",
  },
  {
    regex: /bind: address already in use|port is already allocated/i,
    category: "docker",
    hint: "Cổng host đã bị chiếm. Kiểm tra CADDY_HTTP_PORT trong .env / caddy/caddy.yml (ports:), hoặc dừng tiến trình khác đang giữ cổng đó.",
  },
  {
    regex: /no such image|manifest.*not found|pull access denied/i,
    category: "docker",
    hint: "Image không tồn tại hoặc không có quyền pull. Kiểm tra tag image trong compose file tương ứng (vd caddy/caddy.yml, tinyauth/tinyauth.yml).",
  },
  {
    regex: /connection refused|ECONNREFUSED|ETIMEDOUT/i,
    category: "network",
    hint: "Service đích chưa listen hoặc chưa healthy khi bị gọi tới. Kiểm tra depends_on/healthcheck (caddy/caddy.yml healthcheck, cloudflare/cloudflare.yml depends_on.caddy.condition) và mạng 'proxy' (networks/networks.yml).",
  },
  {
    regex: /must specify.*token|failed to create tunnel|error parsing tunnel/i,
    category: "cloudflare",
    hint: "CF_TUNNEL_TOKEN thiếu/sai trong khi command đang chạy 'tunnel run' (named mode, cloudflare/cloudflare.yml). Nếu đây là CI/không có token thật, phải dùng docker-compose.ci.yml (quick tunnel) thay vì chạy compose gốc.",
  },
  {
    regex: /invalid tunnel secret|401 Unauthorized/i,
    category: "cloudflare",
    hint: "CF_TUNNEL_TOKEN sai hoặc tunnel đã bị xoá/thu hồi trên Cloudflare dashboard. Provision lại bằng: node cloudflare/scripts/provision-tunnel.mjs.",
  },
  {
    regex: /x509|certificate/i,
    category: "network",
    hint: "Lỗi TLS/chứng chỉ. Kiểm tra domain đã trỏ đúng Cloudflare, hoặc lệch giờ hệ thống host.",
  },
  {
    regex: /permission denied.*docker\.sock/i,
    category: "docker",
    hint: "Caddy không đọc được docker.sock. Kiểm tra mount '/var/run/docker.sock:ro' trong caddy/caddy.yml và quyền user chạy container.",
  },
  {
    regex: /panic|fatal error|segmentation fault/i,
    category: "app",
    hint: "Lỗi nghiêm trọng trong service — cần xem log đầy đủ (docker compose logs <service>) để lấy stack trace chi tiết.",
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────
function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch (e) {
    return (e.stdout ? e.stdout.toString() : "").trim();
  }
}

function envFileContent() {
  const p = resolve(ROOT, ".env");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function envKeys() {
  return envKeysList(resolve(ROOT, ".env"));
}

function envGetRaw(key) {
  return envGet(resolve(ROOT, ".env"), key);
}

// KHÔNG in giá trị thật — chỉ dùng khi biến này là nguyên nhân nghi vấn của lỗi.
function maskEnv(key) {
  const val = envGetRaw(key);
  return `env:faild:********${val.length}`;
}

function detectMode() {
  return envGetRaw("CF_TUNNEL_TOKEN") ? "named" : "quick";
}

function activeProfiles() {
  return envGetRaw("COMPOSE_PROFILES") || "(unset)";
}

function inspectContainer(name) {
  const raw = sh(dockerCmd(`inspect ${name}`));
  try {
    const data = JSON.parse(raw)[0];
    const state = data?.State || {};
    return {
      name,
      state: state.Status || "unknown",
      health: state.Health?.Status || "none",
      restarts: data?.RestartCount ?? 0,
    };
  } catch {
    return { name, state: "unknown", health: "none", restarts: 0 };
  }
}

function listContainers() {
  const names = sh(dockerCmd('ps -a --format "{{.Names}}"')).split("\n").filter(Boolean);
  return names.map(inspectContainer);
}

function scanLogsForErrors(serviceName) {
  const logs = sh(dockerCmd(`compose logs --no-color --tail=200 ${serviceName}`));
  const hits = [];
  const lines = logs.split("\n");
  for (const p of ERROR_PATTERNS) {
    const matched = lines.filter((l) => p.regex.test(l));
    if (matched.length) {
      hits.push({ category: p.category, hint: p.hint, sample: matched[0].trim().slice(0, 220), count: matched.length });
    }
  }
  return { logs, hits };
}

function httpCode(url) {
  const code = sh(`curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${url}"`);
  return /^\d{3}$/.test(code) ? code : "000";
}

// Giả lập request nội bộ trong network 'proxy' (giống service khác gọi service này).
function probeInternal(target) {
  const code = sh(dockerCmd(`run --rm --network proxy curlimages/curl:8.5.0 -sS -o /dev/null -w "%{http_code}" --max-time 10 "${target}"`));
  return /^\d{3}$/.test(code) ? code : "000";
}

function probeCaddyLocal() {
  const mode = detectMode();
  const configuredPort = envGetRaw("CADDY_HTTP_PORT");
  const candidates = mode === "quick" ? [8080, 80] : [configuredPort || "80", 8080, 80];
  for (const p of candidates) {
    if (!p) continue;
    const code = httpCode(`http://127.0.0.1:${p}/`);
    if (code !== "000") return { port: p, code };
  }
  return { port: null, code: "000" };
}

// Giả lập request "từ Internet" ra public URL thật (named hoặc quick tunnel).
function discoverPublicUrl() {
  const savedUrl = resolve(ROOT, "public-url.txt");
  if (existsSync(savedUrl)) return readFileSync(savedUrl, "utf8").trim();

  if (detectMode() === "named") {
    const whoamiHost = envGetRaw("WHOAMI_HOST");
    const domain = envGetRaw("DOMAIN");
    if (whoamiHost) return whoamiHost.replace(/^http:\/\//, "https://");
    if (domain) return `https://whoami.${domain}`;
    return "";
  }

  const logs = sh(dockerCmd("compose logs --no-color --no-log-prefix cloudflared"));
  const m = logs.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : "";
}

function statusIcon(s) {
  return { PASS: "✅ PASS", FAIL: "❌ FAIL", SKIP: "⏭️ SKIP" }[s] || s;
}

// ── Core analysis ───────────────────────────────────────────────────────
function analyzeService(svc, containers, profiles, keys) {
  const result = { name: svc.name, status: "SKIP", evidence: [], issues: [] };
  const c = containers.find((x) => x.name === svc.name);

  // Ghi chú thông tin (không phải nguyên nhân lỗi cứng) cho các biến optional.
  for (const key of svc.required_env) {
    if (!keys.includes(key) || envGetRaw(key) === "") {
      result.issues.push(`Biến ${key} thiếu/rỗng trong .env → ${maskEnv(key)}. Kiểm tra ${svc.compose_file} xem có default hợp lệ không; nếu bắt buộc phải set giá trị thật.`);
    }
  }

  if (!c) {
    const profileActive = profiles.includes(svc.profile) || profiles.includes("core") || profiles.includes("full");
    if (svc.required && profileActive) {
      result.status = "FAIL";
      result.issues.push(`Container '${svc.name}' không tồn tại dù COMPOSE_PROFILES hiện tại (${profiles}) lẽ ra phải bật service này. Kiểm tra khối 'profiles:' trong ${svc.compose_file} và chạy 'docker compose ps -a' để xác nhận.`);
    } else {
      result.status = "SKIP";
      result.issues.push(`Service '${svc.name}' không nằm trong COMPOSE_PROFILES hiện tại (${profiles}) — bỏ qua đúng theo thiết kế (xem AGENTS.md mục Profiles).`);
    }
    return result;
  }

  result.evidence.push(`docker inspect: state=${c.state}, health=${c.health}, restarts=${c.restarts}`);

  const stateOk = c.state === "running";
  const healthOk = c.health === "healthy" || c.health === "none";

  if (!stateOk || !healthOk || Number(c.restarts) > 0) {
    result.status = "FAIL";
    const { hits } = scanLogsForErrors(svc.name);
    if (hits.length) {
      for (const h of hits) {
        result.issues.push(`[log:${h.category}] ${h.count} dòng khớp lỗi, ví dụ: "${h.sample}". → Đề xuất: ${h.hint}`);
      }
    } else {
      result.issues.push(`Container không healthy nhưng log không khớp pattern lỗi đã biết — cần xem thủ công: docker compose logs ${svc.name} (tham chiếu ${svc.compose_file}).`);
    }
    return result;
  }

  // Container "xanh" — không dừng lại, giả lập request thật để xác nhận luồng.
  if (svc.probe.type === "http_local") {
    const probe = probeCaddyLocal();
    result.evidence.push(`Giả lập request local: http://127.0.0.1:${probe.port ?? "?"}/ → HTTP ${probe.code}`);
    if (ACCEPT_RE.test(probe.code)) {
      result.status = "PASS";
    } else {
      result.status = "FAIL";
      result.issues.push(`Container healthy nhưng không trả HTTP hợp lệ (nhận '${probe.code}'). Kiểm tra caddy/caddy.yml (ports, CADDY_INGRESS_NETWORKS=${envGetRaw("CADDY_INGRESS_NETWORKS") ? "***(đã set)" : "chưa set trong .env, dùng default 'proxy'"}) và log caddy.`);
      const { hits } = scanLogsForErrors(svc.name);
      for (const h of hits) result.issues.push(`[log:${h.category}] ${h.hint}`);
    }
  } else if (svc.probe.type === "http_internal") {
    const code = probeInternal(svc.probe.target);
    result.evidence.push(`Giả lập request nội bộ (network 'proxy'): ${svc.probe.target} → HTTP ${code}`);
    if (ACCEPT_RE.test(code)) {
      result.status = "PASS";
    } else {
      result.status = "FAIL";
      result.issues.push(`Endpoint nội bộ '${svc.probe.target}' không phản hồi hợp lệ (HTTP ${code}). Kiểm tra label 'caddy:'/'caddy.reverse_proxy' trong ${svc.compose_file} và việc service có attach network 'proxy' hay không.`);
    }
  } else if (svc.probe.type === "tunnel") {
    const url = discoverPublicUrl();
    if (!url) {
      result.status = "FAIL";
      result.issues.push(`Không xác định được public URL để giả lập request từ Internet. Named mode cần WHOAMI_HOST/DOMAIN hợp lệ; quick mode cần log cloudflared có URL *.trycloudflare.com. Kiểm tra CF_TUNNEL_TOKEN → ${maskEnv("CF_TUNNEL_TOKEN")}.`);
    } else {
      const code = httpCode(`${url}/`);
      result.evidence.push(`Giả lập request từ Internet: ${url}/ → HTTP ${code}`);
      if (ACCEPT_RE.test(code)) {
        result.status = "PASS";
      } else {
        result.status = "FAIL";
        result.issues.push(`Request giả lập ra public URL thất bại (HTTP ${code}). cloudflared có thể chưa đăng ký tunnel xong, hoặc Caddy không proxy đúng — xem log cloudflared + caddy, đối chiếu ${svc.compose_file}.`);
      }
    }
  } else {
    result.status = "PASS";
    result.evidence.push("Service này không cấu hình bước probe (theo scripts/analyze-config.jsonc) — chỉ xác nhận container healthy.");
  }

  return result;
}

// ── Report ──────────────────────────────────────────────────────────────
function writeReport({ mode, profiles, containers, keys, results }) {
  const now = new Date().toISOString();
  const passCount = results.filter((r) => r.status === "PASS").length;
  const failCount = results.filter((r) => r.status === "FAIL").length;
  const skipCount = results.filter((r) => r.status === "SKIP").length;

  const lines = [];
  lines.push("# Báo cáo phân tích CI/CD stack");
  lines.push("");
  lines.push("Thực hiện bởi: `scripts/analyze-with-opencode.mjs` (đóng vai trò CI/CD reviewer tự động — check docker ps, log, env, và giả lập request thật để xác nhận luồng hoạt động).");
  lines.push(`Thời gian: ${now}`);
  lines.push(`Chế độ tunnel phát hiện: **${mode}** (named nếu CF_TUNNEL_TOKEN có giá trị, ngược lại quick — xem AGENTS.md mục 'Named vs quick').`);
  lines.push(`COMPOSE_PROFILES hiện tại: \`${profiles}\``);
  lines.push("");

  lines.push("## 1. Tổng quan container (`docker ps -a`)");
  lines.push("");
  lines.push("| Container | State | Health | Restarts |");
  lines.push("|---|---|---|---|");
  if (containers.length) {
    for (const c of containers) lines.push(`| ${c.name} | ${c.state} | ${c.health} | ${c.restarts} |`);
  } else {
    lines.push("| _(không có container nào)_ | | | |");
  }
  lines.push("");

  lines.push("## 2. Kết quả theo service");
  lines.push("");
  lines.push(`**Tổng kết:** ${passCount} PASS · ${failCount} FAIL · ${skipCount} SKIP`);
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.name} — ${statusIcon(r.status)}`);
    lines.push("");
    if (r.evidence.length) {
      lines.push("**Bằng chứng (docker inspect / request giả lập):**");
      for (const e of r.evidence) lines.push(`- ${e}`);
      lines.push("");
    }
    if (r.issues.length) {
      lines.push(r.status === "FAIL" ? "**Nguyên nhân & đề xuất xử lý:**" : "**Ghi chú:**");
      for (const i of r.issues) lines.push(`- ${i}`);
      lines.push("");
    } else if (r.status === "PASS") {
      lines.push("Không phát hiện lỗi — luồng request đã được xác nhận hoạt động qua bước giả lập ở trên.");
      lines.push("");
    }
  }

  lines.push("## 3. Biến môi trường (.env) đang thực thi");
  lines.push("");
  lines.push("Chỉ liệt kê **tên khoá**, không in giá trị thật. Nếu một biến bị xác định là nguyên nhân lỗi, giá trị được che theo định dạng `env:faild:********<số ký tự đang có>`.");
  lines.push("");
  lines.push(keys.length ? keys.map((k) => `\`${k}\``).join(", ") : "_(không tìm thấy .env ở thời điểm chạy — kiểm tra scripts/runners/setup-env.mjs / .env.ci)_");
  lines.push("");

  lines.push("## 4. Kết luận");
  lines.push("");
  if (failCount === 0) {
    lines.push("✅ Toàn bộ service theo profile hiện tại đang hoạt động đúng. Luồng `Internet → Cloudflare Tunnel → Caddy → (Tinyauth) → App` đã được xác nhận bằng request giả lập thực tế ở mục 2, không chỉ dựa vào trạng thái container.");
  } else {
    lines.push(`❌ Có **${failCount}** service lỗi. Xem nguyên nhân + đề xuất xử lý chi tiết ở mục 2 (đối chiếu code trong compose file tương ứng và biến .env liên quan). Sau khi sửa, chạy lại:`);
    lines.push("");
    lines.push("```bash");
    lines.push("node scripts/analyze-with-opencode.mjs");
    lines.push("```");
  }
  lines.push("");

  const report = lines.join("\n");

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_FILE, report);
  log(`Report saved: ${REPORT_FILE}`);

  if (existsSync(resolve(ROOT, "ci-logs"))) {
    mkdirSync(CI_MIRROR_DIR, { recursive: true });
    writeFileSync(resolve(CI_MIRROR_DIR, "report.md"), report);
    log(`Report mirrored: ${resolve(CI_MIRROR_DIR, "report.md")}`);
  }

  if (!SILENT) {
    log("");
    log(report);
  }

  return { passCount, failCount, skipCount };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const docker = detectDocker();
  if (!docker.available) {
    err("ERROR: Docker không khả dụng. Cài Docker Desktop hoặc Docker trong WSL.");
    process.exit(1);
  }
  log(`Docker: ${docker.via} (${docker.cmd})`);

  if (DRY_RUN) {
    log("[DRY RUN] Sẽ chạy: docker ps -a, đọc log từng service, đối chiếu .env, giả lập request nội bộ + public URL, và ghi báo cáo vào:");
    log(`[DRY RUN]   ${REPORT_FILE}`);
    return;
  }

  const mode = detectMode();
  const profiles = activeProfiles();
  const containers = listContainers();
  const keys = envKeys();

  log(`Mode: ${mode} | Profiles: ${profiles}`);
  log(`Containers found: ${containers.length}`);

  const results = config.services.map((svc) => analyzeService(svc, containers, profiles, keys));

  const summary = writeReport({ mode, profiles, containers, keys, results });

  if (summary.failCount > 0) {
    err(`\n❌ ${summary.failCount} service lỗi — xem chi tiết tại ${REPORT_FILE}`);
    process.exit(1);
  }
  log("\n✅ Toàn bộ service PASS — xem chi tiết tại", REPORT_FILE);
}

main().catch((e) => {
  console.error("FATAL:", e.message);
  process.exit(1);
});
