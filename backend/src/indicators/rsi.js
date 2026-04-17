// backend/src/indicators/rsi.js
export function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return 100 - 100 / (1 + (g / period) / ((l / period) || 0.001));
}
