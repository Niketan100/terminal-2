// backend/src/indicators/garch.js
export function garch(prices) {
  if (!prices || prices.length < 20) return null;
  const ret = [];
  for (let i = 1; i < prices.length; i++) ret.push(Math.log(prices[i] / prices[i - 1]));
  const mean = ret.reduce((a, b) => a + b, 0) / ret.length;
  let s2 = ret.reduce((s, r) => s + (r - mean) ** 2, 0) / ret.length;
  const hist = [s2];
  for (let i = 1; i < ret.length; i++) {
    s2 = 0.000002 + 0.1 * ret[i - 1] ** 2 + 0.85 * s2;
    hist.push(s2);
  }
  const cv  = Math.sqrt(s2) * Math.sqrt(288) * 100;
  const pv  = Math.sqrt(hist[hist.length - 5] || s2) * Math.sqrt(288) * 100;
  const chg = ((cv - pv) / (pv || 1)) * 100;
  return {
    currentVol: +cv.toFixed(3), volChangePct: +chg.toFixed(2),
    regime: chg > 8 ? 'EXPANDING' : chg < -8 ? 'CONTRACTING' : 'STABLE',
    mult:   chg > 8 ? 1.35 : chg < -8 ? 0.7 : 1.0,
  };
}
