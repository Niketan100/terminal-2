// ─── Technical Indicators ────────────────────────────────────────────────────

export const ema = (arr, period) => {
  const k = 2 / (period + 1);
  let e = arr[0];
  return arr.map((v, i) => {
    if (i === 0) return v;
    e = v * k + e * (1 - k);
    return e;
  });
};

export const rsi = (arr, period = 14) => {
  const out = new Array(period).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = arr[i] - arr[i - 1];
    d > 0 ? (ag += d) : (al -= d);
  }
  ag /= period;
  al /= period;
  out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = period + 1; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return out;
};

export const macd = (arr) => {
  const e12 = ema(arr, 12);
  const e26 = ema(arr, 26);
  const line = e12.map((v, i) => v - e26[i]);
  const k = 2 / 10;
  let s = line[25];
  const sig = new Array(25).fill(null);
  sig.push(s);
  for (let i = 26; i < line.length; i++) {
    s = line[i] * k + s * (1 - k);
    sig.push(s);
  }
  const hist = line.map((v, i) => (sig[i] !== null ? v - sig[i] : null));
  return { line, sig, hist };
};

export const bb = (arr, period = 20, mult = 2) =>
  arr.map((_, i) => {
    if (i < period - 1) return null;
    const sl = arr.slice(i - period + 1, i + 1);
    const mid = sl.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(sl.reduce((a, b) => a + Math.pow(b - mid, 2), 0) / period);
    return { u: mid + mult * sd, m: mid, l: mid - mult * sd };
  });

export const vwap = (candles, period = 90) => {
  let sumPV = 0;
  let sumV = 0;
  const out = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const p = (c.h + c.l + c.c) / 3;
    const pv = p * c.v;

    sumPV += pv;
    sumV += c.v;

    if (i >= period) {
      const rem = candles[i - period];
      const remP = (rem.h + rem.l + rem.c) / 3;
      sumPV -= remP * rem.v;
      sumV -= rem.v;
    }

    out.push(sumV ? sumPV / sumV : 0);
  }
  return out;
};

export const findSR = (candles, w = 6) => {
  const out = [];
  for (let i = w; i < candles.length - w; i++) {
    const win = candles.slice(i - w, i + w + 1);
    if (win.every((d) => candles[i].h >= d.h)) out.push({ p: candles[i].h, t: 'R', i });
    if (win.every((d) => candles[i].l <= d.l)) out.push({ p: candles[i].l, t: 'S', i });
  }
  return out
    .filter((l, idx, a) => a.findIndex((x) => Math.abs(x.p - l.p) / l.p < 0.002) === idx)
    .slice(-10);
};

export const analyzeSetup = (candles) => {
  if (candles.length < 30) return null;
  const closes = candles.map((c) => c.c);
  const rv = rsi(closes);
  const { hist } = macd(closes);
  const bands = bb(closes);
  const last = candles[candles.length - 1];
  const lastRSI = rv[rv.length - 1];
  const lastHist = hist[hist.length - 1];
  const prevHist = hist[hist.length - 2];
  const lastBB = bands[bands.length - 1];

  const signals = [];
  let confidence = 0;
  let bias = 'NEUTRAL';

  if (lastRSI < 35) {
    signals.push({ t: `RSI Oversold (${lastRSI.toFixed(1)})`, bull: true });
    confidence += 25; bias = 'BULLISH';
  } else if (lastRSI > 65) {
    signals.push({ t: `RSI Overbought (${lastRSI.toFixed(1)})`, bull: false });
    confidence += 25; bias = 'BEARISH';
  } else {
    signals.push({ t: `RSI Neutral (${lastRSI.toFixed(1)})`, bull: null });
  }

  if (lastHist !== null && prevHist !== null) {
    if (lastHist > 0 && prevHist <= 0) {
      signals.push({ t: 'MACD Bullish Cross ▲', bull: true }); confidence += 30; bias = 'BULLISH';
    } else if (lastHist < 0 && prevHist >= 0) {
      signals.push({ t: 'MACD Bearish Cross ▼', bull: false }); confidence += 30; bias = 'BEARISH';
    } else if (lastHist > prevHist && lastHist > 0) {
      signals.push({ t: 'MACD Momentum Rising', bull: true }); confidence += 12;
    } else if (lastHist < prevHist && lastHist < 0) {
      signals.push({ t: 'MACD Momentum Falling', bull: false }); confidence += 12;
    }
  }

  if (lastBB) {
    if (last.c < lastBB.l) {
      signals.push({ t: 'Below BB Lower Band', bull: true }); confidence += 20;
    } else if (last.c > lastBB.u) {
      signals.push({ t: 'Above BB Upper Band', bull: false }); confidence += 20;
    } else {
      signals.push({ t: 'Price Inside BB', bull: null });
    }
  }

  if (last.bv && last.sv) {
    const bvRatio = last.bv / (last.bv + last.sv);
    if (bvRatio > 0.65) {
      signals.push({ t: `Buy Vol Dominant (${(bvRatio * 100).toFixed(0)}%)`, bull: true }); confidence += 15;
    } else if (bvRatio < 0.35) {
      signals.push({ t: `Sell Vol Dominant (${((1 - bvRatio) * 100).toFixed(0)}%)`, bull: false }); confidence += 15;
    }
  }

  confidence = Math.min(confidence, 95);
  const sr = findSR(candles);
  const nearS = sr.filter((l) => l.t === 'S' && Math.abs(l.p - last.c) / last.c < 0.005);
  const nearR = sr.filter((l) => l.t === 'R' && Math.abs(l.p - last.c) / last.c < 0.005);
  if (nearS.length) { signals.push({ t: `Near Support $${nearS[0].p.toFixed(0)}`, bull: true }); confidence += 10; }
  if (nearR.length) { signals.push({ t: `Near Resistance $${nearR[0].p.toFixed(0)}`, bull: false }); confidence += 10; }

  return {
    signals, bias, confidence,
    entry: last.c,
    sl: bias === 'BULLISH' ? last.l * 0.997 : last.h * 1.003,
    tp: bias === 'BULLISH' ? last.c * 1.012 : last.c * 0.988,
  };
};
