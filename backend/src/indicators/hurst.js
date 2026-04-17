// backend/src/indicators/hurst.js
export function hurstExponent(prices) {
  if (!prices || prices.length < 30) return null;
  const ret = [];
  for (let i = 1; i < prices.length; i++) ret.push(Math.log(prices[i] / prices[i - 1]));
  const n = ret.length;
  const lags = [4, 8, 16, Math.floor(n / 2)].filter(l => l < n);
  const rsVals = [];
  for (const lag of lags) {
    const chunks = Math.floor(n / lag); let rsSum = 0;
    for (let c = 0; c < chunks; c++) {
      const sub = ret.slice(c * lag, (c + 1) * lag);
      const m   = sub.reduce((a, b) => a + b, 0) / sub.length;
      let cum = 0;
      const cd  = sub.map(d => { cum += (d - m); return cum; });
      const R   = Math.max(...cd) - Math.min(...cd);
      const S   = Math.sqrt(sub.reduce((s, r) => s + (r - m) ** 2, 0) / sub.length);
      if (S > 0) rsSum += R / S;
    }
    rsVals.push({ lag, rs: rsSum / chunks });
  }
  const lx = rsVals.map(r => Math.log(r.lag)), ly = rsVals.map(r => Math.log(r.rs));
  const mx = lx.reduce((a, b) => a + b, 0) / lx.length, my = ly.reduce((a, b) => a + b, 0) / ly.length;
  const num = lx.reduce((s, x, i) => s + (x - mx) * (ly[i] - my), 0);
  const den = lx.reduce((s, x) => s + (x - mx) ** 2, 0);
  const H   = Math.min(0.95, Math.max(0.05, den > 0 ? num / den : 0.5));
  return {
    H: +H.toFixed(3),
    regime: H > 0.55 ? 'TRENDING' : H < 0.45 ? 'MEAN_REV' : 'RANDOM',
    conf:   H > 0.65 || H < 0.35 ? 'HIGH' : H > 0.58 || H < 0.42 ? 'MED' : 'LOW',
  };
}
