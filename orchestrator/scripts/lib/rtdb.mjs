// orchestrator/scripts/lib/rtdb.mjs
// Kết nối Firebase Realtime Database bằng Service Account JSON (base64).
//
// Env:
//   ORCH_RTDB_SERVICE_ACCOUNT  base64 của service account JSON (khuyến nghị)
//   ORCH_RTDB_SERVICE_ACCOUNT_FILE  đường dẫn tới file JSON (thay thế)
//   ORCH_RTDB_URL              databaseURL, vd https://<project>.firebaseio.com
//   ORCH_STACK                 tên stack (namespace), default "default"
//
// Trả về { db, rootRef, paths } — mọi path đều nằm dưới /orchestrator/<stack>.

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { log, error } from "./log.mjs";
import { viTime } from "./vi-time.mjs";

function loadServiceAccount() {
  const b64 = process.env.ORCH_RTDB_SERVICE_ACCOUNT;
  const file = process.env.ORCH_RTDB_SERVICE_ACCOUNT_FILE;
  let raw;
  if (b64 && b64.trim()) {
    raw = Buffer.from(b64.trim(), "base64").toString("utf8");
  } else if (file && file.trim()) {
    raw = readFileSync(file.trim(), "utf8");
  } else {
    throw new Error(
      "Missing credentials: set ORCH_RTDB_SERVICE_ACCOUNT (base64) or ORCH_RTDB_SERVICE_ACCOUNT_FILE",
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Service account JSON parse failed: ${e.message}`);
  }
}

let _cached = null;

export function connectRtdb() {
  if (_cached) return _cached;

  const databaseURL =
    process.env.ORCH_RTDB_URL ||
    process.env.FIREBASE_DATABASE_URL ||
    "";
  if (!databaseURL) {
    throw new Error("Missing ORCH_RTDB_URL (Realtime Database URL).");
  }

  const serviceAccount = loadServiceAccount();
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL,
  });

  const db = getDatabase();
  const stack = (process.env.ORCH_STACK || process.env.DOMAIN || "default").replace(/[.#$/[\]]/g, "-");
  const base = `orchestrator/${stack}`;

  const paths = {
    base,
    leader: `${base}/leader`,
    lock: `${base}/lock`, // dùng transaction để election
    nodes: `${base}/nodes`,
    node: (id) => `${base}/nodes/${id}`,
    handoff: `${base}/handoff`,
    // nhật ký chuyển giao: 1 record / lần đổi leader thật sự (không phải timeline
    // nhiều pha). Mỗi record: { oldLeader, newLeader, oldLeaderTasks, at, atVi, term }.
    handoffLog: `${base}/handoff/log`,
    events: `${base}/events`,
  };

  log(`RTDB connected: project=${serviceAccount.project_id} stack=${stack}`);
  _cached = { db, rootRef: db.ref(base), paths, stack };
  return _cached;
}

// serverTimestamp helper (ghi giờ theo server RTDB, tránh lệch giờ runner)
export { ServerValue } from "firebase-admin/database";

// Ghi 1 event vào audit log /events (push, kèm timestamp + giờ VN).
export async function pushEvent(type, data = {}) {
  try {
    const { db, paths } = connectRtdb();
    const { ServerValue } = await import("firebase-admin/database");
    const atVi = viTime();
    await db.ref(paths.events).push({
      type,
      at: ServerValue.TIMESTAMP,
      atVi,
      nodeId: process.env.ORCH_NODE_ID || null,
      ...data,
    });
  } catch (e) {
    error(`pushEvent(${type}) failed: ${e.message}`);
  }
}

// Ghi 1 record CHUYỂN GIAO LEADER vào /handoff/log.
//
// YÊU CẦU: chỉ lưu 1 record khi leader THẬT SỰ đổi (leader cũ ≠ leader mới).
// Record gồm: { oldLeader, newLeader, oldLeaderTasks, at, atVi, term }.
//
//   oldLeader      : { nodeId, host, term } — leader trước khi đổi
//   newLeader      : { nodeId, host, term } — leader sau khi đổi
//   oldLeaderTasks : mảng kết quả pipeline mà leader cũ đã chạy trong lần
//                    handoff này (upload-data, stop-cloudflared, ...). Rỗng
//                    nếu leader đổi do chết/tín hiệu chứ không phải handoff chủ động.
//   term           : term của leader mới (fencing token)
//   reason         : "handoff" | "leader-stale" | "signal" | "acquire-empty"
//
// Nếu oldLeader.nodeId === newLeader.nodeId thì KHÔNG ghi (không có thay đổi
// thật sự) → tránh noise như cũ.
export async function pushHandoffLog({ oldLeader, newLeader, oldLeaderTasks = [], reason = "handoff", term }) {
  try {
    const { db, paths } = connectRtdb();
    const { ServerValue } = await import("firebase-admin/database");
    const oldId = oldLeader?.nodeId || null;
    const newId = newLeader?.nodeId || null;
    if (oldId && newId && oldId === newId) {
      // Không có thay đổi leader thật sự → bỏ qua (tránh noise).
      return null;
    }
    const entry = {
      oldLeader: oldId
        ? { nodeId: oldId, host: oldLeader?.host || null, term: oldLeader?.term ?? null }
        : null,
      newLeader: newId
        ? { nodeId: newId, host: newLeader?.host || null, term: newLeader?.term ?? null }
        : null,
      oldLeaderTasks,
      reason,
      term: term ?? newLeader?.term ?? null,
      at: ServerValue.TIMESTAMP,
      atVi: viTime(),
      nodeId: process.env.ORCH_NODE_ID || null,
    };
    const ref = await db.ref(paths.handoffLog).push(entry);
    log(
      `Handoff log ← leader đổi ${oldId || "(none)"} → ${newId || "(none)"} (reason=${reason}, term=${entry.term}, tasks=${oldLeaderTasks.length})`,
    );
    return ref.key;
  } catch (e) {
    error(`pushHandoffLog failed: ${e.message}`);
    return null;
  }
}
