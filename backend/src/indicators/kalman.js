// backend/src/indicators/kalman.js
export function kalmanFilter(prices) {
  if (!prices || prices.length < 5) return null;
  let x = prices[0], v = 0, p = 1, pv = 0;
  for (let i = 1; i < prices.length; i++) {
    const xP = x + v, pP = p + pv + 0.01;
    const K = pP / (pP + 0.1), inn = prices[i] - xP;
    x = xP + K * inn; v = v + 0.1 * inn;
    p = (1 - K) * pP; pv = pv + 0.0001;
  }
  const vPct = (v / (x || 1)) * 100;
  return {
    price: x, velocityPct: vPct,
    trend: vPct > 0.015 ? 'UP' : vPct < -0.015 ? 'DOWN' : 'FLAT',
    strength: Math.min(1, Math.abs(vPct) / 0.05),
  };
}
