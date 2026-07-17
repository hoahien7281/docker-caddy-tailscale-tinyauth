// orchestrator/scripts/elect.mjs
// Leader election qua RTDB transaction (consul-style).
//
// /leader = { nodeId, term, host, publicUrl, heartbeat, acquiredAt }
//
// Quy tắc:
//   - Node chỉ giành leader khi CHƯA có leader, HOẶC leader cũ đã "hết hạn"
//     (heartbeat quá TTL) → term++ (fencing token, tránh split-brain).
//   - Leader giữ ghế bằng renewLeadership() (đập heartbeat lên /leader).
//   - Standby gọi tryAcquire() theo chu kỳ; khi leader cũ chết sẽ tiếp quản.

import { connectRtdb } from "./lib/rtdb.mjs";
import { heartbeatTtlMs } from "./lib/node-identity.mjs";
import { viTime } from "./lib/vi-time.mjs";
import { log } from "./lib/log.mjs";

function now() {
  return Date.now();
}

function valueOrNull(value) {
  return value === undefined || value === "" ? null : value;
}

export function describeLeader(leader, at = now()) {
  if (!leader || !leader.nodeId) return "none";
  const ageMs = at - (leader.heartbeat || 0);
  return `node=${leader.nodeId} host=${leader.host || "(n/a)"} term=${leader.term || 0} heartbeatAgeMs=${ageMs}`;
}

// Thử giành quyền leader. Trả { acquired, term, leader }.
export async function tryAcquire({ nodeId, host, publicUrl }) {
  const { db, paths } = connectRtdb();
  const ttl = heartbeatTtlMs();
  const ref = db.ref(paths.leader);

  const result = await ref.transaction((current) => {
    const t = now();
    const tVi = viTime(t);
    if (!current || !current.nodeId) {
      // Chưa có leader → giành ngay, term = 1.
      return {
        nodeId,
        term: 1,
        host: valueOrNull(host),
        publicUrl: valueOrNull(publicUrl),
        acquiredAt: t,
        acquiredAtVi: tVi,
        heartbeat: t,
        heartbeatVi: tVi,
      };
    }
    if (current.nodeId === nodeId) {
      // Mình đang là leader → renew.
      return { ...current, heartbeat: t, heartbeatVi: tVi, publicUrl: valueOrNull(publicUrl || current.publicUrl) };
    }
    const stale = t - (current.heartbeat || 0) > ttl;
    if (stale) {
      // Leader cũ chết → tiếp quản, tăng term (fencing).
      return {
        nodeId,
        term: (current.term || 0) + 1,
        host: valueOrNull(host),
        publicUrl: valueOrNull(publicUrl),
        acquiredAt: t,
        acquiredAtVi: tVi,
        heartbeat: t,
        heartbeatVi: tVi,
      };
    }
    // Leader còn sống → abort transaction (giữ nguyên).
    return; // undefined => abort
  });

  const snap = result.snapshot.val();
  const acquired = result.committed && snap && snap.nodeId === nodeId;
  if (acquired) log(`Acquired leadership: term=${snap.term} node=${nodeId}`);
  return {
    acquired,
    term: snap?.term,
    leader: snap,
    blockedBy: acquired ? null : snap,
    ttlMs: ttl,
  };
}

// Leader renew heartbeat trên /leader (kèm publicUrl mới nếu có).
export async function renewLeadership({ nodeId, publicUrl }) {
  const { db, paths } = connectRtdb();
  const ref = db.ref(paths.leader);
  const snap = await ref.get();
  const current = snap.val();
  if (!current || current.nodeId !== nodeId) return { held: false, leader: current };
  const heartbeat = now();
  const heartbeatVi = viTime(heartbeat);
  await ref.update({
    heartbeat,
    heartbeatVi,
    publicUrl: valueOrNull(publicUrl || current.publicUrl),
  });
  return { held: true, leader: { ...current, heartbeat, heartbeatVi } };
}

// Chủ động nhường ghế (dùng trong graceful handoff).
export async function releaseLeadership({ nodeId }) {
  const { db, paths } = connectRtdb();
  const ref = db.ref(paths.leader);
  const nowMs = now();
  await ref.transaction((current) => {
    if (!current || current.nodeId !== nodeId) return;
    // Đặt heartbeat=0 để node kế tiếp thấy "stale" và tiếp quản ngay.
    return { ...current, heartbeat: 0, releasedAt: nowMs, releasedAtVi: viTime(nowMs) };
  });
  log(`Released leadership: node=${nodeId}`);
}

export async function getLeader() {
  const { db, paths } = connectRtdb();
  const snap = await db.ref(paths.leader).get();
  return snap.val();
}
