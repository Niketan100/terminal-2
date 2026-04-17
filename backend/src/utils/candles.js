// backend/src/utils/candles.js
import { toMs } from './time.js';

export function isLastCandleClosed(candles) {
  if (!candles || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  if (last.live === true)  return false;
  if (last.live === false) return true;
  if (last.t && candles.length >= 2) {
    const prev = candles[candles.length - 2];
    const interval = (last.t - prev.t) * 1000;
    const age = Date.now() - toMs(last.t);
    if (age < interval * 0.15) return false;
  }
  return true;
}
