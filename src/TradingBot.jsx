// TradingBot.jsx — v5 · Institutional Engine
// Levels + Quant Models + Liquidity Sweep + Dynamic TP + Adaptive Trailing SL

import {
  useEffect, useRef, useState, useCallback, useMemo,
  forwardRef, useImperativeHandle
} from 'react';

// ═══════════════════════════════════════════════════════════════════
//  MATH CORE
// ═══════════════════════════════════════════════════════════════════

function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}
function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return 100 - 100 / (1 + (g / period) / ((l / period) || 0.001));
}
function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, lo = candles[i].l, pc = candles[i - 1].c;
    trs.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ── KALMAN FILTER ─────────────────────────────────────────────────
function kalmanFilter(prices) {
  if (!prices || prices.length < 5) return null;
  let x = prices[0], v = 0, p = 1, pv = 0;
  const Q = 0.01, R = 0.1;
  for (let i = 1; i < prices.length; i++) {
    const xP = x + v, pP = p + pv + Q;
    const K = pP / (pP + R), inn = prices[i] - xP;
    x = xP + K * inn; v = v + 0.1 * inn; p = (1 - K) * pP; pv = pv + Q * 0.01;
  }
  const vPct = (v / (x || 1)) * 100;
  return { price: x, velocity: v, velocityPct: vPct,
    trend: vPct > 0.015 ? 'UP' : vPct < -0.015 ? 'DOWN' : 'FLAT',
    strength: Math.min(1, Math.abs(vPct) / 0.05) };
}

// ── GARCH(1,1) ────────────────────────────────────────────────────
function garch(prices) {
  if (!prices || prices.length < 20) return null;
  const ret = [];
  for (let i = 1; i < prices.length; i++) ret.push(Math.log(prices[i] / prices[i - 1]));
  const mean = ret.reduce((a, b) => a + b, 0) / ret.length;
  let s2 = ret.reduce((s, r) => s + (r - mean) ** 2, 0) / ret.length;
  const hist = [s2];
  for (let i = 1; i < ret.length; i++) { s2 = 0.000002 + 0.1 * ret[i-1]**2 + 0.85 * s2; hist.push(s2); }
  const cv = Math.sqrt(s2) * Math.sqrt(288) * 100;
  const pv = Math.sqrt(hist[hist.length - 5] || s2) * Math.sqrt(288) * 100;
  const chg = ((cv - pv) / (pv || 1)) * 100;
  return { currentVol: +cv.toFixed(3), volChangePct: +chg.toFixed(2),
    regime: chg > 8 ? 'EXPANDING' : chg < -8 ? 'CONTRACTING' : 'STABLE',
    mult: chg > 8 ? 1.35 : chg < -8 ? 0.7 : 1.0 };
}

// ── HURST EXPONENT ────────────────────────────────────────────────
function hurstExponent(prices) {
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
      const m = sub.reduce((a, b) => a + b, 0) / sub.length;
      let cum = 0;
      const cd = sub.map(d => { cum += (d - m); return cum; });
      const R = Math.max(...cd) - Math.min(...cd);
      const S = Math.sqrt(sub.reduce((s, r) => s + (r - m) ** 2, 0) / sub.length);
      if (S > 0) rsSum += R / S;
    }
    rsVals.push({ lag, rs: rsSum / chunks });
  }
  const lx = rsVals.map(r => Math.log(r.lag)), ly = rsVals.map(r => Math.log(r.rs));
  const mx = lx.reduce((a, b) => a + b, 0) / lx.length, my = ly.reduce((a, b) => a + b, 0) / ly.length;
  const num = lx.reduce((s, x, i) => s + (x - mx) * (ly[i] - my), 0);
  const den = lx.reduce((s, x) => s + (x - mx) ** 2, 0);
  const H = Math.min(0.95, Math.max(0.05, den > 0 ? num / den : 0.5));
  return { H: +H.toFixed(3),
    regime: H > 0.55 ? 'TRENDING' : H < 0.45 ? 'MEAN_REV' : 'RANDOM',
    conf:   H > 0.65 || H < 0.35 ? 'HIGH' : H > 0.58 || H < 0.42 ? 'MED' : 'LOW' };
}

// ── VOLUME PROFILE ────────────────────────────────────────────────
function volumeProfile(candles, buckets = 30) {
  if (!candles || candles.length < 10) return null;
  const minP = Math.min(...candles.map(c => c.l));
  const maxP = Math.max(...candles.map(c => c.h));
  const step = (maxP - minP) / buckets || 1;
  const prof = Array.from({ length: buckets }, (_, i) => ({
    price: minP + (i + 0.5) * step, lo: minP + i * step, hi: minP + (i + 1) * step, vol: 0
  }));
  for (const c of candles) {
    const vol = c.v || 1;
    for (const b of prof) {
      const ov = Math.min(c.h, b.hi) - Math.max(c.l, b.lo);
      if (ov > 0) b.vol += vol * (ov / ((c.h - c.l) || step));
    }
  }
  const tot = prof.reduce((s, b) => s + b.vol, 0);
  const poc = prof.reduce((a, b) => b.vol > a.vol ? b : a);
  let acc = poc.vol, lo = prof.indexOf(poc), hi = lo;
  while (acc < tot * 0.7 && (lo > 0 || hi < prof.length - 1)) {
    const aL = lo > 0 ? prof[lo-1].vol : 0, aH = hi < prof.length-1 ? prof[hi+1].vol : 0;
    if (aH >= aL) { hi++; acc += aH; } else { lo--; acc += aL; }
  }
  return { poc: +poc.price.toFixed(1), vah: +prof[hi].hi.toFixed(1), val: +prof[lo].lo.toFixed(1),
    keyLevels: [
      { price: +prof[hi].hi.toFixed(1), label: 'VAH', strength: 4 },
      { price: +poc.price.toFixed(1),   label: 'POC', strength: 5 },
      { price: +prof[lo].lo.toFixed(1), label: 'VAL', strength: 4 },
    ]};
}

// ── MICROSTRUCTURE ────────────────────────────────────────────────
function microstructure(trades = [], orderBook = {}, windowMs = 120000) {
  const now = Date.now();
  const rec = trades.filter(t => t.tms && t.tms >= now - windowMs);
  let bv = 0, sv = 0;
  for (const t of rec) { const s = parseFloat(t.size||0); if (t.side==='buy') bv+=s; else sv+=s; }
  const delta = bv - sv, tot = bv + sv || 1, dr = delta / tot;
  const bids = (orderBook.bids||[]).slice(0,10), asks = (orderBook.asks||[]).slice(0,10);
  const bw = bids.reduce((s,b)=>s+(b[1]||0),0), aw = asks.reduce((s,a)=>s+(a[1]||0),0);
  const obi = (bw - aw) / ((bw + aw) || 1);
  const score = dr * 0.6 + obi * 0.4;
  const pm = rec.length > 1 ? Math.abs(rec[0].price - rec[rec.length-1].price) / (rec[rec.length-1].price||1) : 0;
  return { delta: +delta.toFixed(4), deltaRatio: +dr.toFixed(3), obImbalance: +obi.toFixed(3),
    score: +score.toFixed(3), absorbed: tot > 0.5 && pm < 0.001,
    bias: score > 0.15 ? 'BUY' : score < -0.15 ? 'SELL' : 'NEUTRAL',
    recentTrades: rec.length };
}

// ═══════════════════════════════════════════════════════════════════
//  LEVEL ENGINE
// ═══════════════════════════════════════════════════════════════════

function findSwingPoints(candles, lookback = 5) {
  const pts = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i]; let isH = true, isL = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isH = false;
      if (candles[j].l <= c.l) isL = false;
    }
    if (isH) pts.push({ price: c.h, idx: i, origin: 'high' });
    if (isL) pts.push({ price: c.l, idx: i, origin: 'low' });
  }
  return pts;
}

function clusterLevels(points, pct = 0.0025) {
  const zones = [], used = new Set();
  const sorted = [...points].sort((a, b) => a.price - b.price);
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const cluster = [sorted[i].price], idxs = [sorted[i].idx ?? i];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(sorted[j].price - sorted[i].price) / sorted[i].price < pct) {
        cluster.push(sorted[j].price); idxs.push(sorted[j].idx ?? j); used.add(j);
      }
    }
    used.add(i);
    zones.push({ price: cluster.reduce((a,b)=>a+b,0)/cluster.length,
      strength: cluster.length, lastTouch: Math.max(...idxs), source: 'swing' });
  }
  return zones.sort((a, b) => b.strength - a.strength);
}

function buildAllLevels(candles, vpData) {
  if (!candles || candles.length < 20) return [];
  const swingPts = findSwingPoints(candles.slice(-200), 4);
  const zones    = clusterLevels(swingPts);
  if (vpData) {
    for (const vp of vpData.keyLevels) {
      const near = zones.find(z => Math.abs(z.price - vp.price) / vp.price < 0.002);
      if (near) { near.strength += vp.strength; near.source = `${near.source}+${vp.label}`; }
      else zones.push({ price: vp.price, strength: vp.strength, source: vp.label, lastTouch: 0 });
    }
  }
  return zones.sort((a, b) => b.strength - a.strength);
}

function classifyLevels(zones, price, atr) {
  const buf = atr ? atr * 0.2 : price * 0.001;
  return {
    supports:    zones.filter(z => price > z.price + buf).sort((a,b) => b.price - a.price),
    resistances: zones.filter(z => price < z.price - buf).sort((a,b) => a.price - b.price),
    atLevel:     zones.filter(z => Math.abs(z.price - price) <= (atr ? atr * 0.6 : price * 0.002)),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  LIQUIDITY SWEEP DETECTOR
//  A sweep = price breaks above a swing high (or below a swing low)
//  then closes back inside. This triggers stop hunts.
//  We wait for the REVERSAL candle after the sweep → enter opposite direction.
// ═══════════════════════════════════════════════════════════════════

function detectLiquiditySweep(candles, zones, atr) {
  if (!candles || candles.length < 6 || !atr) return null;
  const last  = candles[candles.length - 1];
  const prev  = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];
  const sweepBuffer = atr * 0.3;

  // Bearish liquidity sweep (bull trap):
  // Candle pierced ABOVE a resistance level, then closed BACK BELOW it
  // → price swept the highs (triggered buy stops), now reversing down
  for (const z of zones) {
    // Sweep high: prior candle broke above level, current closed back below
    if (prev.h > z.price + sweepBuffer && prev.c < z.price &&
        last.c < z.price && last.c < last.o) {
      // Confirmation: bearish close after sweep
      const bodyPct = Math.abs(last.c - last.o) / ((last.h - last.l) || 1);
      if (bodyPct > 0.3) {
        return {
          type:       'BEAR_SWEEP',
          direction:  'SELL',
          sweptLevel: z,
          sweepHigh:  prev.h,
          entryNote:  `Swept high $${z.price.toFixed(0)} (str×${z.strength}) → bearish reversal`,
          confidence: Math.min(95, 60 + z.strength * 8 + Math.round(bodyPct * 30)),
        };
      }
    }
    // Sweep low: prior candle broke below level, current closed back above → bullish
    if (prev.l < z.price - sweepBuffer && prev.c > z.price &&
        last.c > z.price && last.c > last.o) {
      const bodyPct = Math.abs(last.c - last.o) / ((last.h - last.l) || 1);
      if (bodyPct > 0.3) {
        return {
          type:       'BULL_SWEEP',
          direction:  'BUY',
          sweptLevel: z,
          sweepLow:   prev.l,
          entryNote:  `Swept low $${z.price.toFixed(0)} (str×${z.strength}) → bullish reversal`,
          confidence: Math.min(95, 60 + z.strength * 8 + Math.round(bodyPct * 30)),
        };
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  DYNAMIC TP ENGINE
//  Scans between current price and original TP.
//  If a significant level exists in between → move TP there.
//  Prevents giving back profits by running into hidden resistance.
// ═══════════════════════════════════════════════════════════════════

function getDynamicTP({ markPrice, side, originalTP, supports, resistances, allZones, atr }) {
  if (!originalTP) return { tp: null, adjusted: false, reason: 'No original TP' };
  const minMove = atr ? atr * 0.5 : Math.abs(originalTP - markPrice) * 0.1;

  if (side === 'buy') {
    // Find any resistance between current price+minMove and originalTP
    const inRange = resistances.filter(z =>
      z.price > markPrice + minMove && z.price < originalTP - atr * 0.2
    ).sort((a, b) => b.strength - a.strength);
    // Take the strongest one (not the closest — avoid being too conservative)
    const strongest = inRange.find(z => z.strength >= 2);
    if (strongest) return { tp: strongest.price, adjusted: true,
      reason: `Resistance $${strongest.price.toFixed(0)} (str×${strongest.strength}) inside target — TP moved` };
  } else {
    const inRange = supports.filter(z =>
      z.price < markPrice - minMove && z.price > originalTP + atr * 0.2
    ).sort((a, b) => b.strength - a.strength);
    const strongest = inRange.find(z => z.strength >= 2);
    if (strongest) return { tp: strongest.price, adjusted: true,
      reason: `Support $${strongest.price.toFixed(0)} (str×${strongest.strength}) inside target — TP moved` };
  }
  return { tp: originalTP, adjusted: false, reason: 'TP unchanged — no strong level in path' };
}

// ═══════════════════════════════════════════════════════════════════
//  ADAPTIVE TRAILING SL
//  Moves SL in trade's favor only (ratchet).
//  Uses ATR×2.2 so normal volatility doesn't stop it out.
//  Also checks: if price approaches a strong level, tighten to ATR×1.3.
// ═══════════════════════════════════════════════════════════════════

function getTrailingSL({ markPrice, side, currentSL, entryPrice, atr, supports, resistances }) {
  if (!atr) return currentSL;
  const normalTrail = atr * 2.2;   // breathing room
  const tightTrail  = atr * 1.3;   // near a level

  // Check if price is near a key level (tighten trail)
  const nearLevel = side === 'buy'
    ? resistances.some(z => z.strength >= 2 && z.price < markPrice + atr * 1.5 && z.price > markPrice)
    : supports.some(z => z.strength >= 2 && z.price > markPrice - atr * 1.5 && z.price < markPrice);

  const trail    = nearLevel ? tightTrail : normalTrail;
  const newSL    = side === 'buy' ? markPrice - trail : markPrice + trail;

  // Ratchet: only move SL in favorable direction
  if (side === 'buy'  && newSL > (currentSL || -Infinity)) return +newSL.toFixed(1);
  if (side === 'sell' && newSL < (currentSL || Infinity))  return +newSL.toFixed(1);
  return currentSL;
}

// ═══════════════════════════════════════════════════════════════════
//  CANDLE PATTERN
// ═══════════════════════════════════════════════════════════════════

function detectPattern(candles) {
  if (!candles || candles.length < 3) return null;
  const c = candles[candles.length-1], p = candles[candles.length-2];
  const range = (c.h-c.l)||0.001, body = Math.abs(c.c-c.o);
  const uw = c.h-Math.max(c.c,c.o), lw = Math.min(c.c,c.o)-c.l;
  if (uw/range > 0.55 && body/range < 0.35 && c.c < p.c) return { dir:'bear', label:'Bearish pin', conf: Math.round(uw/range*100) };
  if (lw/range > 0.55 && body/range < 0.35 && c.c > p.c) return { dir:'bull', label:'Bullish pin', conf: Math.round(lw/range*100) };
  if (p.c > p.o && c.c < c.o && c.o >= p.c && c.c <= p.o) return { dir:'bear', label:'Bearish engulf', conf:80 };
  if (p.c < p.o && c.c > c.o && c.o <= p.c && c.c >= p.o) return { dir:'bull', label:'Bullish engulf', conf:80 };
  const l3 = candles.slice(-3);
  const ab = l3.reduce((s,x)=>s+Math.abs(x.c-x.o),0)/3, ar = l3.reduce((s,x)=>s+(x.h-x.l),0)/3;
  const pr = candles.length>8 ? candles.slice(-8,-3).reduce((s,x)=>s+(x.h-x.l),0)/5 : ar*2;
  if (ab/(ar||1) < 0.35 && ar < pr*0.55) return { dir:'neutral', label:'Compression', conf:65 };
  return null;
}

// ═══════════════════════════════════════════════════════════════════
//  SIGNAL ENGINE — combines levels + quant + sweep
// ═══════════════════════════════════════════════════════════════════

function computeSignal({ candles, markPrice, trades, orderBook, allZones, classified }) {
  if (!candles || candles.length < 40 || !markPrice) return null;
  const closes  = candles.map(c => c.c);
  const atr     = calcATR(candles);
  const rsiVal  = calcRSI(closes);
  const pattern = detectPattern(candles);
  const { supports, resistances, atLevel } = classified;

  // ── Quant models ──────────────────────────────────────────────
  const kalman = kalmanFilter(closes.slice(-60));
  const garchR = garch(closes.slice(-80));
  const hurst  = hurstExponent(closes.slice(-60));
  const vp     = volumeProfile(candles.slice(-100));
  const micro  = microstructure(trades, orderBook, 120000);

  // ── Liquidity sweep (highest priority signal) ─────────────────
  const sweep  = detectLiquiditySweep(candles, allZones, atr);

  // ── Level gate: only trade if AT a significant level ──────────
  // (unless it's a sweep — sweeps can occur at non-clustered levels)
  const atSignificantLevel = atLevel.length > 0 && atLevel.some(z => z.strength >= 2);

  // ── Score components ──────────────────────────────────────────
  const kalmanScore = kalman
    ? (kalman.velocityPct > 0.02 ? 40 : kalman.velocityPct > 0.008 ? 20 :
       kalman.velocityPct < -0.02 ? -40 : kalman.velocityPct < -0.008 ? -20 : 0)
    : 0;
  const microScore  = micro ? micro.score * 100 : 0;
  const rsiScore    = rsiVal > 72 ? -30 : rsiVal < 32 ? 30 : rsiVal > 60 ? -10 : rsiVal < 42 ? 10 : 0;
  const patScore    = pattern?.dir === 'bull' ? pattern.conf * 0.4 : pattern?.dir === 'bear' ? -pattern.conf * 0.4 : 0;
  const levelBoost  = atSignificantLevel ? 1 + atLevel[0].strength * 0.12 : 0.55;
  const garchMult   = garchR?.mult || 1.0;
  const hurstMode   = hurst?.regime || 'RANDOM';

  let rawScore = 0;
  if (hurstMode === 'TRENDING')
    rawScore = kalmanScore*0.45 + microScore*0.30 + rsiScore*0.10 + patScore*0.15;
  else if (hurstMode === 'MEAN_REV')
    rawScore = kalmanScore*0.15 + microScore*0.20 + rsiScore*0.30 + patScore*0.35;
  else
    rawScore = kalmanScore*0.30 + microScore*0.25 + rsiScore*0.25 + patScore*0.20;

  rawScore *= garchMult * levelBoost;
  const compositeScore = +Math.min(100, Math.max(-100, rawScore)).toFixed(1);

  // Threshold: higher in random walk
  const threshold = hurstMode === 'TRENDING' ? 22 : hurstMode === 'MEAN_REV' ? 28 : 35;

  // ── Determine signal ──────────────────────────────────────────
  let signal = 'HOLD', signalSource = 'quant', sweepConf = 0;

  // 1. Liquidity sweep overrides everything (with trend filter)
  if (sweep) {
    const trendOk = sweep.direction === 'BUY'
      ? (kalman?.trend === 'UP' || hurstMode === 'MEAN_REV')
      : (kalman?.trend === 'DOWN' || hurstMode === 'MEAN_REV');
    if (trendOk || sweep.sweptLevel.strength >= 3) {
      signal = sweep.direction; signalSource = 'sweep'; sweepConf = sweep.confidence;
    }
  }

  // 2. Quant composite (if no sweep)
  if (signal === 'HOLD') {
    if (compositeScore > threshold && atSignificantLevel) { signal = 'BUY';  signalSource = 'quant'; }
    if (compositeScore < -threshold && atSignificantLevel) { signal = 'SELL'; signalSource = 'quant'; }
  }

  // 3. Level bounce fallback (no quant score needed, just pattern + level + trend)
  if (signal === 'HOLD' && atSignificantLevel && pattern) {
    const trend = kalman?.trend || 'FLAT';
    if (pattern.dir === 'bull' && (trend === 'UP' || hurstMode === 'MEAN_REV') && rsiVal < 62) {
      signal = 'BUY'; signalSource = 'level_bounce';
    }
    if (pattern.dir === 'bear' && (trend === 'DOWN' || hurstMode === 'MEAN_REV') && rsiVal > 42) {
      signal = 'SELL'; signalSource = 'level_bounce';
    }
  }

  // ── Build targets ─────────────────────────────────────────────
  let tp = null, sl = null, rr = null, tpAdjusted = false, tpReason = '';
  if (signal !== 'HOLD') {
    const side = signal === 'BUY' ? 'buy' : 'sell';
    // Initial TP = next level
    if (side === 'buy' && resistances[0]) tp = resistances[0].price;
    if (side === 'sell' && supports[0])   tp = supports[0].price;
    // Initial SL = level that invalidates, with buffer
    if (side === 'buy' && supports[0])
      sl = supports[0].price - (atr ? atr * 0.3 : markPrice * 0.001);
    if (side === 'sell' && resistances[0])
      sl = resistances[0].price + (atr ? atr * 0.3 : markPrice * 0.001);

    // Dynamic TP check
    if (tp) {
      const dynTP = getDynamicTP({ markPrice, side, originalTP: tp, supports, resistances, allZones, atr });
      if (dynTP.adjusted) { tp = dynTP.tp; tpAdjusted = true; tpReason = dynTP.reason; }
    }

    // R:R check
    if (tp && sl) {
      const rew = side === 'buy' ? tp - markPrice : markPrice - tp;
      const risk = side === 'buy' ? markPrice - sl : sl - markPrice;
      rr = risk > 0 ? +(rew / risk).toFixed(2) : null;
    }
    // Reject if R:R < 1.4 (unless sweep — sweeps allow 1.2 because high confidence)
    const minRR = signalSource === 'sweep' ? 1.2 : 1.4;
    if (!rr || rr < minRR) signal = 'HOLD';
  }

  return {
    signal, compositeScore, threshold, signalSource, sweepConf,
    sweep, models: { kalman, garchR, hurst, vp, micro },
    scores: { kalmanScore: +kalmanScore.toFixed(1), microScore: +microScore.toFixed(1), rsiScore, patScore: +patScore.toFixed(1) },
    hurstMode, garchMult, atLevel, atSignificantLevel, pattern,
    tp, sl, rr, tpAdjusted, tpReason,
    valid: signal !== 'HOLD' && tp !== null && sl !== null,
    reason: buildReason({ signal, compositeScore, signalSource, sweep, kalman, garchR, hurst, micro, atLevel, pattern, rsiVal, tp, sl, rr }),
  };
}

function buildReason({ signal, compositeScore, signalSource, sweep, kalman, garchR, hurst, micro, atLevel, pattern, rsiVal, tp, sl, rr }) {
  const parts = [];
  if (signalSource === 'sweep' && sweep) parts.push(`SWEEP: ${sweep.entryNote}`);
  if (hurst)   parts.push(`H=${hurst.H}[${hurst.regime}]`);
  if (garchR)  parts.push(`GARCH:${garchR.regime}`);
  if (kalman)  parts.push(`K:${kalman.trend} v=${kalman.velocityPct.toFixed(3)}%`);
  if (micro)   parts.push(`Flow:${micro.bias} δ=${micro.deltaRatio.toFixed(2)}`);
  if (atLevel.length) parts.push(`Level:$${atLevel[0].price.toFixed(0)}×${atLevel[0].strength}`);
  if (pattern) parts.push(pattern.label);
  parts.push(`RSI:${rsiVal?.toFixed(1)}`);
  parts.push(`Score:${compositeScore}`);
  if (rr) parts.push(`R:R=${rr}`);
  return parts.join(' · ');
}

// ═══════════════════════════════════════════════════════════════════
//  HOOK
// ═══════════════════════════════════════════════════════════════════

export function useTradingBot({ candles, markPrice, trades, orderBook, openPosition, closePosition, positions, log }) {
  const [running, setRunning]       = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [stats, setStats]           = useState({ trades:0, wins:0, losses:0, totalPnl:0, sweepTrades:0 });
  const [botLog, setBotLog]         = useState([]);
  const [allZones, setAllZones]     = useState([]);
  const [classified, setClassified] = useState({ supports:[], resistances:[], atLevel:[] });
  const [vpData, setVpData]         = useState(null);

  const botPosIdRef   = useRef(null);
  const activeTpRef   = useRef(null);   // current TP (may be adjusted)
  const originalTpRef = useRef(null);   // original TP from entry
  const activeSlRef   = useRef(null);   // current SL (trailing)
  const activeSideRef = useRef(null);
  const entryPriceRef = useRef(null);
  const intervalRef   = useRef(null);
  const trailActiveRef = useRef(false); // start trailing only after price moves in our favor

  const addLog = useCallback((msg, type = 'info') => {
    const ts = new Date().toLocaleTimeString();
    setBotLog(l => [{ ts, msg, type }, ...l].slice(0, 120));
    if (log) log(`[BOT] ${msg}`, type);
  }, [log]);

  // Rebuild levels
  useEffect(() => {
    if (!candles || candles.length < 20) return;
    const vp    = volumeProfile(candles.slice(-100));
    setVpData(vp);
    setAllZones(buildAllLevels(candles, vp));
  }, [candles]);

  // Reclassify on price change (dynamic role reversal)
  useEffect(() => {
    if (!allZones.length || !markPrice) return;
    const atr = calcATR(candles);
    setClassified(classifyLevels(allZones, markPrice, atr));
  }, [allZones, markPrice, candles]);

  const tick = useCallback(() => {
    if (!candles || candles.length < 40 || !markPrice) return;

    const result = computeSignal({ candles, markPrice, trades, orderBook, allZones, classified });
    if (!result) return;
    setLastResult(result);

    const hasOpenPos = botPosIdRef.current !== null && positions.some(p => p.id === botPosIdRef.current);
    const atr        = calcATR(candles);
    const { supports, resistances } = classified;

    // ── Manage open position ──────────────────────────────────
    if (hasOpenPos) {
      const pos  = positions.find(p => p.id === botPosIdRef.current);
      if (pos) {
        const side  = activeSideRef.current;
        const entry = entryPriceRef.current || pos.entry;

        // Activate trailing SL once price moves 1 ATR in our favor
        if (!trailActiveRef.current && atr) {
          const moved = side === 'buy' ? markPrice - entry : entry - markPrice;
          if (moved >= atr) { trailActiveRef.current = true; addLog('Trailing SL activated', 'muted'); }
        }

        // Update trailing SL
        if (trailActiveRef.current && atr) {
          const newSL = getTrailingSL({ markPrice, side, currentSL: activeSlRef.current, entryPrice: entry, atr, supports, resistances });
          if (newSL !== activeSlRef.current) {
            activeSlRef.current = newSL;
            addLog(`Trail SL → $${newSL.toFixed(1)}`, 'muted');
          }
        }

        // Dynamic TP update: scan for new levels in path
        if (activeTpRef.current && atr) {
          const dynTP = getDynamicTP({ markPrice, side, originalTP: originalTpRef.current,
            supports, resistances, allZones, atr });
          if (dynTP.adjusted && dynTP.tp !== activeTpRef.current) {
            activeTpRef.current = dynTP.tp;
            addLog(`Dynamic TP → $${dynTP.tp.toFixed(1)} · ${dynTP.reason}`, 'warn');
          }
        }

        // Exit checks
        const hitTP  = side === 'buy' ? markPrice >= activeTpRef.current : markPrice <= activeTpRef.current;
        const hitSL  = side === 'buy' ? markPrice <= activeSlRef.current : markPrice >= activeSlRef.current;
        const kExit  = result.models.kalman && (
          (side === 'buy'  && result.models.kalman.velocityPct < -0.035) ||
          (side === 'sell' && result.models.kalman.velocityPct >  0.035));

        if (hitTP || hitSL || kExit) {
          const pnl = side === 'buy'
            ? pos.qty * (markPrice - entry)
            : pos.qty * (entry - markPrice);
          closePosition(botPosIdRef.current);
          setStats(s => ({ ...s, trades: s.trades+1,
            wins: pnl>0 ? s.wins+1 : s.wins, losses: pnl<=0 ? s.losses+1 : s.losses,
            totalPnl: s.totalPnl + pnl }));
          const why = hitTP ? 'TP hit' : kExit ? 'Kalman reversal' : 'SL hit';
          addLog(`EXIT [${why}] ${pnl>=0?'+':''}$${pnl.toFixed(2)} @ $${markPrice.toFixed(1)}`, pnl>0?'success':'danger');
          botPosIdRef.current = null; activeTpRef.current = null; originalTpRef.current = null;
          activeSlRef.current = null; activeSideRef.current = null;
          entryPriceRef.current = null; trailActiveRef.current = false;
        }
      }
    }

    // ── Enter ──────────────────────────────────────────────────
    if (!hasOpenPos && result.valid) {
      const side = result.signal === 'BUY' ? 'buy' : 'sell';
      openPosition(side, null);
      const id = Date.now();
      botPosIdRef.current   = id;
      activeTpRef.current   = result.tp;
      originalTpRef.current = result.tp;
      activeSlRef.current   = result.sl;
      activeSideRef.current = side;
      entryPriceRef.current = markPrice;
      trailActiveRef.current = false;
      if (result.signalSource === 'sweep') setStats(s => ({ ...s, sweepTrades: s.sweepTrades+1 }));
      addLog(`${result.signal} [${result.signalSource.toUpperCase()}] Score:${result.compositeScore} R:R:${result.rr}`, side==='buy'?'success':'warn');
      if (result.tpAdjusted) addLog(`  TP adjusted: ${result.tpReason}`, 'warn');
      addLog(`  TP:$${result.tp?.toFixed(1)} SL:$${result.sl?.toFixed(1)} · ${result.reason}`, 'muted');
    }
  }, [candles, markPrice, trades, orderBook, openPosition, closePosition, positions, allZones, classified, addLog]);

  useEffect(() => {
    if (running) { intervalRef.current = setInterval(tick, 4000); }
    else { clearInterval(intervalRef.current); }
    return () => clearInterval(intervalRef.current);
  }, [running, tick]);

  const start = useCallback(() => {
    setRunning(true);
    addLog('Engine started · Levels + Quant + Sweep + Dynamic TP + Trail SL', 'success');
  }, [addLog]);
  const stop  = useCallback(() => { setRunning(false); addLog('Stopped','warn'); }, [addLog]);
  const reset = useCallback(() => {
    setRunning(false);
    setStats({ trades:0, wins:0, losses:0, totalPnl:0, sweepTrades:0 }); setBotLog([]);
    botPosIdRef.current=null; activeTpRef.current=null; originalTpRef.current=null;
    activeSlRef.current=null; activeSideRef.current=null; entryPriceRef.current=null;
    trailActiveRef.current=false; addLog('Reset','muted');
  }, [addLog]);

  const winRate = (stats.wins+stats.losses) > 0
    ? Math.round(stats.wins/(stats.wins+stats.losses)*100) : null;

  return { running, lastResult, stats, botLog, winRate, allZones, classified, vpData, start, stop, reset };
}

// ═══════════════════════════════════════════════════════════════════
//  PANEL UI
// ═══════════════════════════════════════════════════════════════════

const SIG_COLOR  = { BUY:'#00ffe1', SELL:'#ff7ab0', HOLD:'#94a3b8' };
const SIG_BG     = { BUY:'rgba(0,255,209,0.07)', SELL:'rgba(255,92,158,0.07)', HOLD:'rgba(148,163,184,0.04)' };
const SIG_BORDER = { BUY:'rgba(0,255,209,0.2)', SELL:'rgba(255,92,158,0.2)', HOLD:'rgba(148,163,184,0.08)' };
const H_COL = { TRENDING:'#34d399', MEAN_REV:'#f87171', RANDOM:'#fbbf24' };
const G_COL = { EXPANDING:'#f87171', CONTRACTING:'#34d399', STABLE:'#94a3b8' };
const SRC_COL = { sweep:'#fbbf24', quant:'#9ddfff', level_bounce:'#34d399' };

function Bar({ val, max=100, color='#00ffe1' }) {
  const pct = Math.min(100, Math.abs(val||0)/max*100);
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5, height:12 }}>
      <div style={{ flex:1, height:3, background:'rgba(255,255,255,0.05)', borderRadius:2, overflow:'hidden' }}>
        <div style={{ width:`${pct}%`, height:'100%', background:color, borderRadius:2, transition:'width .4s' }}/>
      </div>
      <span style={{ fontSize:10, color, minWidth:34, textAlign:'right', fontWeight:700 }}>
        {(val||0)>0?'+':''}{+(val||0).toFixed(1)}
      </span>
    </div>
  );
}

export const BotPanel = forwardRef(function BotPanel(
  { candles, markPrice, trades, orderBook, openPosition, closePosition, positions, log }, ref
) {
  const bot = useTradingBot({ candles, markPrice, trades, orderBook, openPosition, closePosition, positions, log });
  const { running, lastResult, stats, botLog, winRate, allZones, classified, vpData, start, stop, reset } = bot;
  useImperativeHandle(ref, () => ({ start, stop, reset }), [start, stop, reset]);

  const [showModels, setShowModels] = useState(true);
  const [showLevels, setShowLevels] = useState(false);

  const sig = lastResult?.signal || 'HOLD';
  const m   = lastResult?.models || {};
  const sc  = lastResult?.scores || {};
  const { supports, resistances, atLevel } = classified;

  return (
    <div style={{ display:'flex', flexDirection:'column' }}>
      <div className="phdr" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span>Quant Bot v5</span>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          {lastResult?.signalSource && lastResult.signal !== 'HOLD' && (
            <span style={{ fontSize:9, fontWeight:700, color:SRC_COL[lastResult.signalSource]||'#94a3b8',
              background:'rgba(255,255,255,0.04)', padding:'1px 6px', borderRadius:10 }}>
              {lastResult.signalSource.toUpperCase()}
            </span>
          )}
          <div style={{ width:6, height:6, borderRadius:'50%', background:running?'#34d399':'#475569',
            boxShadow:running?'0 0 5px #34d399':'none', animation:running?'pulse 1.8s infinite':'none' }}/>
        </div>
      </div>

      <div style={{ padding:'8px 10px', display:'flex', flexDirection:'column', gap:7 }}>

        {/* Sweep alert */}
        {lastResult?.sweep && (
          <div style={{ padding:'6px 10px', borderRadius:7, fontSize:11, fontWeight:700,
            background:'rgba(251,191,36,0.1)', border:'1px solid rgba(251,191,36,0.3)', color:'#fbbf24' }}>
            SWEEP DETECTED · {lastResult.sweep.type} · conf {lastResult.sweep.confidence}%
            <div style={{ fontSize:9, fontWeight:400, color:'#856c1a', marginTop:2 }}>{lastResult.sweep.entryNote}</div>
          </div>
        )}

        {/* Signal row */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:5 }}>
          <div style={{ background:SIG_BG[sig], border:`1px solid ${SIG_BORDER[sig]}`, borderRadius:8, padding:'7px 9px' }}>
            <div style={{ fontSize:9, color:'#475569' }}>Signal</div>
            <div style={{ fontWeight:800, fontSize:17, color:SIG_COLOR[sig] }}>{sig}</div>
            <div style={{ fontSize:9, color:SRC_COL[lastResult?.signalSource]||'#334155' }}>
              {lastResult?.signalSource?.replace('_',' ') || '—'}
            </div>
          </div>
          <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.04)', borderRadius:8, padding:'7px 9px' }}>
            <div style={{ fontSize:9, color:'#475569' }}>Score</div>
            <div style={{ fontWeight:800, fontSize:17, color:(lastResult?.compositeScore||0)>0?'#00ffe1':(lastResult?.compositeScore||0)<0?'#ff7ab0':'#94a3b8' }}>
              {lastResult?.compositeScore ?? '—'}
            </div>
            <div style={{ fontSize:9, color:'#334155' }}>±{lastResult?.threshold ?? '—'}</div>
          </div>
          <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.04)', borderRadius:8, padding:'7px 9px' }}>
            <div style={{ fontSize:9, color:'#475569' }}>Hurst</div>
            <div style={{ fontWeight:800, fontSize:13, color:H_COL[lastResult?.hurstMode]||'#94a3b8' }}>
              {m.hurst?.H ?? '—'}
            </div>
            <div style={{ fontSize:9, color:H_COL[lastResult?.hurstMode]||'#334155' }}>
              {lastResult?.hurstMode?.replace('_',' ') || '—'}
            </div>
          </div>
        </div>

        {/* At-level alert */}
        {atLevel.length > 0 && (
          <div style={{ padding:'5px 9px', borderRadius:6, fontSize:10, fontWeight:700,
            background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.18)', color:'#fbbf24' }}>
            AT LEVEL: {atLevel.map(z=>`$${z.price.toFixed(0)} [${z.source||''}×${z.strength}]`).join(' · ')}
          </div>
        )}

        {/* TP / SL / R:R */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:5 }}>
          {[
            ['TP'+(lastResult?.tpAdjusted?' ✦':''), lastResult?.tp?.toFixed(0), '#34d399'],
            ['Trail SL', lastResult?.sl?.toFixed(0), '#f87171'],
            ['R:R', lastResult?.rr, lastResult?.rr>=2?'#34d399':lastResult?.rr>=1.5?'#fbbf24':'#f87171'],
          ].map(([l,v,c]) => (
            <div key={l} style={{ borderRadius:6, padding:'5px 6px', textAlign:'center',
              background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.04)' }}>
              <div style={{ fontSize:9, color:'#475569' }}>{l}</div>
              <div style={{ fontSize:12, fontWeight:700, color:c }}>
                {v ? `$${v}` : '—'}
              </div>
            </div>
          ))}
        </div>
        {lastResult?.tpAdjusted && (
          <div style={{ fontSize:9, color:'#856c1a', lineHeight:1.5, padding:'3px 6px',
            background:'rgba(251,191,36,0.04)', borderRadius:5 }}>✦ {lastResult.tpReason}</div>
        )}

        {/* Model toggle */}
        <button className={`btn ${showModels?'btn-on':''}`}
          style={{ fontSize:10, padding:'4px 8px', textAlign:'left' }}
          onClick={() => setShowModels(s=>!s)}>
          {showModels?'▾':'▸'} Model readouts
        </button>

        {showModels && (
          <div style={{ display:'flex', flexDirection:'column', gap:5 }}>

            {/* Hurst bar */}
            <div style={{ background:'rgba(255,255,255,0.02)', borderRadius:7, padding:'6px 9px', border:'1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                <span style={{ fontSize:10, color:'#475569' }}>Hurst — market regime</span>
                <span style={{ fontSize:10, fontWeight:700, color:H_COL[m.hurst?.regime]||'#94a3b8' }}>{m.hurst?.conf||'—'}</span>
              </div>
              <div style={{ position:'relative', height:6, background:'rgba(255,255,255,0.05)', borderRadius:3 }}>
                <div style={{ position:'absolute', left:'45%', top:0, width:1, height:'100%', background:'rgba(255,255,255,0.15)' }}/>
                <div style={{ position:'absolute', left:'55%', top:0, width:1, height:'100%', background:'rgba(255,255,255,0.15)' }}/>
                {m.hurst && <div style={{ width:`${m.hurst.H*100}%`, height:'100%',
                  background:H_COL[m.hurst.regime], borderRadius:3, transition:'width .5s' }}/>}
              </div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:9, color:'#334155', marginTop:2 }}>
                <span>mean-rev</span><span>random</span><span>trending</span>
              </div>
            </div>

            {/* GARCH */}
            <div style={{ background:'rgba(255,255,255,0.02)', borderRadius:7, padding:'6px 9px', border:'1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                <span style={{ fontSize:10, color:'#475569' }}>GARCH volatility</span>
                <span style={{ fontSize:10, fontWeight:700, color:G_COL[m.garchR?.regime]||'#94a3b8' }}>{m.garchR?.regime||'—'}</span>
              </div>
              <div style={{ display:'flex', gap:10, fontSize:11 }}>
                <span style={{ color:'#94a3b8' }}>Vol <b style={{ color:'#e6faff' }}>{m.garchR?.currentVol??'—'}%</b></span>
                <span style={{ color:'#94a3b8' }}>Δ <b style={{ color:(m.garchR?.volChangePct||0)>0?'#f87171':'#34d399' }}>
                  {m.garchR?.volChangePct??'—'}%</b></span>
                <span style={{ color:'#475569' }}>×{lastResult?.garchMult??'—'}</span>
              </div>
            </div>

            {/* Kalman */}
            <div style={{ background:'rgba(255,255,255,0.02)', borderRadius:7, padding:'6px 9px', border:'1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                <span style={{ fontSize:10, color:'#475569' }}>Kalman filter</span>
                <span style={{ fontSize:10, fontWeight:700, color:m.kalman?.trend==='UP'?'#34d399':m.kalman?.trend==='DOWN'?'#f87171':'#94a3b8' }}>
                  {m.kalman?.trend||'—'}</span>
              </div>
              <div style={{ display:'flex', gap:8, fontSize:11, marginBottom:3 }}>
                <span style={{ color:'#94a3b8' }}>Price <b style={{ color:'#e6faff' }}>${m.kalman?.price.toFixed(1)??'—'}</b></span>
                <span style={{ color:'#94a3b8' }}>Vel <b style={{ color:(m.kalman?.velocityPct||0)>0?'#34d399':'#f87171' }}>
                  {m.kalman?.velocityPct?.toFixed(4)??'—'}%</b></span>
              </div>
              <Bar val={sc.kalmanScore} color={(sc.kalmanScore||0)>=0?'#34d399':'#f87171'}/>
            </div>

            {/* Microstructure */}
            <div style={{ background:'rgba(255,255,255,0.02)', borderRadius:7, padding:'6px 9px', border:'1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                <span style={{ fontSize:10, color:'#475569' }}>Microstructure</span>
                <span style={{ fontSize:10, fontWeight:700, color:m.micro?.bias==='BUY'?'#34d399':m.micro?.bias==='SELL'?'#f87171':'#94a3b8' }}>
                  {m.micro?.bias||'—'}{m.micro?.absorbed?' · ABS':''}
                </span>
              </div>
              <div style={{ display:'flex', gap:8, fontSize:11, marginBottom:3 }}>
                <span style={{ color:'#94a3b8' }}>δ <b style={{ color:(m.micro?.deltaRatio||0)>0?'#34d399':'#f87171' }}>
                  {m.micro?.deltaRatio?.toFixed(3)??'—'}</b></span>
                <span style={{ color:'#94a3b8' }}>OB <b style={{ color:(m.micro?.obImbalance||0)>0?'#34d399':'#f87171' }}>
                  {m.micro?.obImbalance?.toFixed(3)??'—'}</b></span>
              </div>
              <Bar val={sc.microScore} color={(sc.microScore||0)>=0?'#34d399':'#f87171'}/>
            </div>

            {/* VP levels */}
            {vpData && (
              <div style={{ background:'rgba(255,255,255,0.02)', borderRadius:7, padding:'6px 9px', border:'1px solid rgba(255,255,255,0.03)' }}>
                <div style={{ fontSize:10, color:'#475569', marginBottom:4 }}>Volume profile levels</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:4 }}>
                  {[['VAH',vpData.vah,'#f87171'],['POC',vpData.poc,'#fbbf24'],['VAL',vpData.val,'#34d399']].map(([l,v,c])=>(
                    <div key={l} style={{ textAlign:'center', background:'rgba(0,0,0,0.15)', borderRadius:5, padding:'4px' }}>
                      <div style={{ fontSize:9, color:c }}>{l}</div>
                      <div style={{ fontSize:11, fontWeight:700, color:'#e6faff' }}>${v}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Reason */}
        {lastResult?.reason && (
          <div style={{ fontSize:10, color:'#5b7e93', background:'rgba(0,0,0,0.18)',
            padding:'5px 8px', borderRadius:5, lineHeight:1.7 }}>{lastResult.reason}</div>
        )}

        {/* Stats */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:3 }}>
          {[['Trades',stats.trades,'#9ddfff'],['Wins',stats.wins,'#34d399'],['Loss',stats.losses,'#f87171'],
            ['Win%',winRate!=null?`${winRate}%`:'—',winRate!=null?(winRate>=50?'#34d399':'#f87171'):'#94a3b8'],
            ['Sweeps',stats.sweepTrades,'#fbbf24']].map(([l,v,c])=>(
            <div key={l} style={{ background:'rgba(255,255,255,0.02)', borderRadius:5, padding:'4px',
              textAlign:'center', border:'1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ fontSize:9, color:'#475569', marginBottom:1 }}>{l}</div>
              <div style={{ fontSize:12, fontWeight:800, color:c }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:11, color:'#94a3b8' }}>Total PnL</span>
          <span style={{ fontWeight:800, fontSize:15, color:stats.totalPnl>=0?'#00ffe1':'#ff7ab0' }}>
            {stats.totalPnl>=0?'+':''}${stats.totalPnl.toFixed(2)}</span>
        </div>

        {/* Controls */}
        <div style={{ display:'flex', gap:6 }}>
          {!running
            ? <button className="btn btn-green" style={{ flex:1, fontSize:11 }} onClick={start}>▶ Start</button>
            : <button className="btn btn-red"   style={{ flex:1, fontSize:11 }} onClick={stop}>■ Stop</button>}
          <button className="btn" style={{ fontSize:11 }} onClick={reset}>Reset</button>
          <button className={`btn ${showLevels?'btn-on':''}`} style={{ fontSize:11 }}
            onClick={() => setShowLevels(l=>!l)}>Levels ({allZones.length})</button>
        </div>

        {/* Levels */}
        {showLevels && (
          <div style={{ background:'rgba(0,0,0,0.2)', borderRadius:7, padding:'8px', border:'1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:5 }}>
              Swing + VP unified pool · role dynamic · ${markPrice?.toFixed(0)} now
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              {[['↑ RESISTANCE', resistances, '#f87171'], ['↓ SUPPORT', supports, '#34d399']].map(([t,zs,col])=>(
                <div key={t}>
                  <div style={{ fontSize:9, color:col, marginBottom:4 }}>{t}</div>
                  {zs.slice(0,6).map((z,i)=>(
                    <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:11,
                      padding:'2px 0', borderBottom:'1px solid rgba(255,255,255,0.03)',
                      color:i===0?col:'#7f9fb5', fontWeight:i===0?700:400 }}>
                      <span>${z.price.toFixed(1)}</span>
                      <span style={{ fontSize:9, color:'#334155' }}>{z.source} ×{z.strength}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Log */}
        <div style={{ maxHeight:115, overflowY:'auto', display:'flex', flexDirection:'column', gap:2,
          background:'rgba(0,0,0,0.18)', borderRadius:6, padding:'5px 8px', border:'1px solid rgba(255,255,255,0.03)' }}>
          {botLog.length===0 && <div style={{ color:'#334155', fontSize:10 }}>Press Start.</div>}
          {botLog.map((l,i)=>(
            <div key={i} style={{ display:'flex', gap:7, fontSize:10, lineHeight:1.5 }}>
              <span style={{ color:'#1e3a5f', flexShrink:0 }}>{l.ts}</span>
              <span style={{ color:l.type==='success'?'#34d399':l.type==='danger'?'#f87171':
                l.type==='warn'?'#fbbf24':l.type==='muted'?'#2d4a5e':'#7f9fb5', wordBreak:'break-word' }}>{l.msg}</span>
            </div>
          ))}
        </div>
        <div style={{ fontSize:9, color:'#1e3a5f', lineHeight:1.7 }}>
          Levels gate entries. Sweep overrides quant. Dynamic TP adjusts to hidden resistance. Trail SL ratchets with ATR. All exits respect institutional levels.
        </div>
      </div>
    </div>
  );
});

/*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  INTEGRATION — same as v4, no changes needed.
  trades + orderBook already passed in.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*/
