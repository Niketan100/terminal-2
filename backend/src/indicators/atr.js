// backend/src/indicators/atr.js
export function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, lo = candles[i].l, pc = candles[i - 1].c;
    trs.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}
