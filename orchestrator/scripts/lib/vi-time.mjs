// orchestrator/scripts/lib/vi-time.mjs
// Helper định dạng giờ Việt Nam (UTC+7) cho dữ liệu ghi lên RTDB.
//
// YÊU CẦU: "Thêm các thông tin giờ VN vào dữ liệu của các key đang lưu trong
// rtdb, ví dụ có ghi nhận giờ timestamp rồi, thì ghi nhận thêm giờ việt nam
// vào, theo định dạng: yyyy-MM-dd HH:mm:ss".
//
// Dùng cho mọi field *Vi (atVi, heartbeatVi, startedAtVi, acquiredAtVi...).
// Chấp nhận sai số vài trăm ms so với ServerValue.TIMESTAMP (server-side).

const VN_OFFSET_MS = 7 * 60 * 60 * 1000; // UTC+7

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Định dạng một timestamp (ms hoặc Date) thành chuỗi giờ VN
 * theo định dạng: yyyy-MM-dd HH:mm:ss
 *
 * @param {number|Date} ts — timestamp ms hoặc Date object (mặc định = now)
 * @returns {string} — "2026-07-17 08:12:44"
 */
export function viTime(ts = Date.now()) {
  const d = ts instanceof Date ? ts : new Date(ts);
  // Dùng Intl với timeZone Asia/Bangkok để lấy đúng giờ VN, rồi ghép thành
  // chuỗi yyyy-MM-dd HH:mm:ss. Cách này an toàn với DST (VN không có DST).
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Trả về object chứa cặp { <field>, <field>Vi } để merge vào payload RTDB.
 * VD: withVi("at") => { at: Date.now(), atVi: "2026-07-17 08:12:44" }
 *
 * Dùng cho caller muốn ghi cả timestamp (number) lẫn chuỗi VN.
 */
export function withVi(field, ts = Date.now()) {
  return { [field]: ts, [`${field}Vi`]: viTime(ts) };
}

export { VN_OFFSET_MS };
