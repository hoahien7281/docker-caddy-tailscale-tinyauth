// orchestrator/scripts/lib/cleanup.mjs
// XÓA LOG LÂU NGÀY trong RTDB (YÊU CẦU: "xóa các log lâu ngày, tất cả key có
// trong đó, ví dụ cái nào lớn hơn n ngày thì xóa đi").
//
// Quét các path append-log (events, handoff/log) và nodes (stopped lâu) rồi
// xoá record có timestamp > maxAgeDays.
//
// KHÔNG xoá:
//   - /leader hiện tại (dù cũ — leader có cơ chế TTL riêng của election).
//   - node còn sống (heartbeat chưa quá TTL).
//
// Env:
//   ORCH_LOG_RETENTION_DAYS  số ngày giữ lại (mặc định 7). 0 = tắt cleanup.
//
// Chạy:
//   - Tự động trong main.mjs (mỗi ORCH_CLEANUP_INTERVAL_SECONDS, mặc định 3600s).
//   - Thủ công: node scripts/cleanup.mjs

import { connectRtdb } from "./rtdb.mjs";
import { heartbeatTtlMs } from "./node-identity.mjs";
import { log, warn, error } from "./log.mjs";

export function retentionDays() {
  const n = Number(process.env.ORCH_LOG_RETENTION_DAYS ?? 7);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 = tắt
}

export function cleanupIntervalMs() {
  const s = Number(process.env.ORCH_CLEANUP_INTERVAL_SECONDS ?? 3600);
  return (Number.isFinite(s) && s > 0 ? s : 3600) * 1000;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Xoá log cũ trong RTDB.
 * @returns {{deleted:number, scanned:number, paths:string[]}}
 */
export async function cleanupOldLogs({ maxAgeDays } = {}) {
  const days = maxAgeDays ?? retentionDays();
  if (days <= 0) {
    log(`[cleanup] ORCH_LOG_RETENTION_DAYS=0 → bỏ qua`);
    return { deleted: 0, scanned: 0, paths: [], reason: "disabled" };
  }
  const cutoff = Date.now() - days * DAY_MS;
  const { db, paths } = connectRtdb();
  let totalDeleted = 0;
  let totalScanned = 0;
  const touchedPaths = [];

  // Parse timestamp từ entry: ưu tiên `at` (number ms), fallback `atVi` (chuỗi).
  function entryTs(entry) {
    if (entry.at) return entry.at;
    if (entry.atVi) {
      const t = new Date(entry.atVi.replace(" ", "T") + "+07:00").getTime();
      if (t) return t;
    }
    return 0;
  }

  // 1. /events — audit log: xoá entry có at < cutoff.
  try {
    const snap = await db.ref(paths.events).get();
    const val = snap.val() || {};
    const toDelete = [];
    for (const [key, entry] of Object.entries(val)) {
      totalScanned++;
      const ts = entryTs(entry);
      if (ts && ts < cutoff) toDelete.push(key);
    }
    if (toDelete.length) {
      const updates = {};
      for (const k of toDelete) updates[`${paths.events}/${k}`] = null;
      await db.ref().update(updates);
      totalDeleted += toDelete.length;
      touchedPaths.push(`events(${toDelete.length})`);
    }
  } catch (e) {
    warn(`[cleanup] events: ${e.message}`);
  }

  // 2. /handoff/log — nhật ký chuyển giao: xoá record có at < cutoff.
  try {
    const snap = await db.ref(paths.handoffLog).get();
    const val = snap.val() || {};
    const toDelete = [];
    for (const [key, entry] of Object.entries(val)) {
      totalScanned++;
      const ts = entryTs(entry);
      if (ts && ts < cutoff) toDelete.push(key);
    }
    if (toDelete.length) {
      const updates = {};
      for (const k of toDelete) updates[`${paths.handoffLog}/${k}`] = null;
      await db.ref().update(updates);
      totalDeleted += toDelete.length;
      touchedPaths.push(`handoff/log(${toDelete.length})`);
    }
  } catch (e) {
    warn(`[cleanup] handoff/log: ${e.message}`);
  }

  // 3. /nodes — xoá node record đã "stopped" lâu hơn cutoff.
  //    Node còn sống (heartbeat < TTL) KHÔNG xoá.
  try {
    const snap = await db.ref(paths.nodes).get();
    const val = snap.val() || {};
    const ttl = heartbeatTtlMs();
    const now = Date.now();
    const toDelete = [];
    for (const [key, node] of Object.entries(val)) {
      totalScanned++;
      const alive = now - (node.heartbeat || 0) <= ttl;
      if (alive) continue; // còn sống → giữ
      // Node chết: dùng stoppedAt/updatedAt/startedAt để xét.
      const ts = node.stoppedAt || node.updatedAt || node.startedAt || 0;
      let tsMs = ts;
      if (!tsMs) {
        const tsVi = node.stoppedAtVi || node.updatedAtVi || node.startedAtVi;
        if (tsVi) tsMs = new Date(tsVi.replace(" ", "T") + "+07:00").getTime() || 0;
      }
      if (tsMs && tsMs < cutoff) toDelete.push(key);
    }
    if (toDelete.length) {
      const updates = {};
      for (const k of toDelete) updates[`${paths.nodes}/${k}`] = null;
      await db.ref().update(updates);
      totalDeleted += toDelete.length;
      touchedPaths.push(`nodes(${toDelete.length})`);
    }
  } catch (e) {
    warn(`[cleanup] nodes: ${e.message}`);
  }

  log(`[cleanup] done: deleted=${totalDeleted} scanned=${totalScanned} paths=[${touchedPaths.join(", ")}] cutoff=${new Date(cutoff).toISOString()}`);
  return { deleted: totalDeleted, scanned: totalScanned, paths: touchedPaths };
}
