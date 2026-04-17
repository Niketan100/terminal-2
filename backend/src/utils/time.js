// backend/src/utils/time.js
export function toMs(ts) {
  if (!ts) return 0;
  return ts > 1e12 ? ts : ts * 1000;
}
