// TradingBot.jsx — v8 · Behaviour-at-Level Engine
// Core logic: Macro trend + Proven level + Behaviour confirmation = trade
// Three setups: ProvenHighRejection · CompressionBreakdown · BottomRecovery

import { useEffect, useRef, useState, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';

// ═══════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_CONFIG = {
  // Level quality — proven levels only
  levelMinTouches:       3,      // min clean touches across history
  levelTouchZoneAtr:     0.8,    // ATR× radius to count a touch
  levelRejectionMin:     0.5,    // min ATR× rejection per touch
  levelAgHalflife:       100,    // age decay half-life (candles)
  levelClusterPct:       0.003,  // cluster within 0.3%
  levelRoleReversalMult: 1.6,    // bonus for levels tested from both sides

  // Macro trend
  macroEmaPeriod:        50,     // EMA for macro trend direction
  macroEmaStrong:        200,    // EMA for strong trend filter

  // Market structure
  structureLookback:     20,     // candles to determine HH/LL/LH/HL
  structureMinSwing:     0.8,    // min ATR× to qualify a swing

  // Behaviour detection
  struggleCandles:       4,      // candles of small range = struggle
  struggleAtrMult:       0.45,   // candle range < ATR×this = small
  compressionCandles:    5,      // candles for compression check
  compressionAtrMult:    0.40,   // max body/ATR for compression
  breakoutAtrMult:       1.2,    // min range for breakout candle

  // Microstructure
  microWindowMs:         120000,
  microBiasThresh:       0.10,

  // Trade management
  trailNormalAtr:        2.0,
  trailTightAtr:         1.2,
  trailActivateAtr:      0.8,
  minRR:                 1.5,
  minRRSweep:            1.2,

  // Sweep
  sweepBodyPct:          0.30,
  sweepBufferAtr:        0.20,
};

// ═══════════════════════════════════════════════════════════════════
//  MATH PRIMITIVES
// ═══════════════════════════════════════════════════════════════════

function calcEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
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

function calcRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  return 100 - 100 / (1 + (g / period) / ((l / period) || 0.001));
}

// ═══════════════════════════════════════════════════════════════════
//  MACRO TREND ENGINE
//  Uses long-term EMAs + market structure (HH/HL vs LH/LL)
// ═══════════════════════════════════════════════════════════════════

function getMacroTrend(candles, cfg) {
  if (!candles || candles.length < cfg.macroEmaPeriod + 5) return null;
  const closes  = candles.map(c => c.c);
  const ema50   = calcEMA(closes, cfg.macroEmaPeriod);
  const ema200  = calcEMA(closes, cfg.macroEmaStrong);
  const price   = closes[closes.length - 1];

  // Market structure: find recent swing highs and lows
  const atr  = calcATR(candles);
  const lb   = candles.length;
  const look = Math.min(cfg.structureLookback, Math.floor(lb / 3));
  const swings = [];
  for (let i = 3; i < lb - 3; i++) {
    const c = candles[i]; let isH = true, isL = true;
    for (let j = i - 3; j <= i + 3; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isH = false;
      if (candles[j].l <= c.l) isL = false;
    }
    if (isH && (c.h - candles[i-1].l) > (atr * cfg.structureMinSwing))
      swings.push({ type:'H', price:c.h, idx:i });
    if (isL && (candles[i-1].h - c.l) > (atr * cfg.structureMinSwing))
      swings.push({ type:'L', price:c.l, idx:i });
  }

  // Last 4 swings: determine HH/HL (uptrend) or LH/LL (downtrend)
  const recent = swings.slice(-6);
  const recentHighs = recent.filter(s => s.type === 'H');
  const recentLows  = recent.filter(s => s.type === 'L');
  let structureBias = 'NEUTRAL';
  if (recentHighs.length >= 2 && recentLows.length >= 2) {
    const hhScore = recentHighs[recentHighs.length-1].price > recentHighs[recentHighs.length-2].price ? 1 : -1;
    const hlScore = recentLows[recentLows.length-1].price  > recentLows[recentLows.length-2].price  ? 1 : -1;
    if (hhScore > 0 && hlScore > 0) structureBias = 'UP';
    if (hhScore < 0 && hlScore < 0) structureBias = 'DOWN';
  }

  // EMA score
  let emaScore = 0;
  if (price > ema50)  emaScore++;
  if (ema50 && ema200 && ema50 > ema200)  emaScore++;
  if (price > (ema200 || ema50)) emaScore++;

  const dir      = emaScore >= 2 && structureBias !== 'DOWN' ? 'UP'
                 : emaScore <= 1 && structureBias !== 'UP'   ? 'DOWN' : 'NEUTRAL';
  const strong   = emaScore >= 2 && structureBias === dir;

  return {
    dir, strong, emaScore, structureBias,
    ema50:  ema50  ? +ema50.toFixed(1)  : null,
    ema200: ema200 ? +ema200.toFixed(1) : null,
    recentHighs: recentHighs.slice(-2),
    recentLows:  recentLows.slice(-2),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  PROVEN LEVEL ENGINE
//  A level must be "proven" by the market itself — multiple clean
//  historical tests, not just swing pivots
// ═══════════════════════════════════════════════════════════════════

function buildProvenLevels(candles, cfg) {
  if (!candles || candles.length < 30) return [];
  const n   = candles.length;
  const atr = calcATR(candles) || 1;
  const tz  = atr * cfg.levelTouchZoneAtr;

  // Collect all pivot candidates
  const candidates = [];
  for (let i = 4; i < n - 4; i++) {
    const c = candles[i]; let isH = true, isL = true;
    for (let j = i - 4; j <= i + 4; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isH = false;
      if (candles[j].l <= c.l) isL = false;
    }
    if (isH) candidates.push({ price: c.h, idx: i });
    if (isL) candidates.push({ price: c.l, idx: i });
  }

  // Cluster candidates
  const sorted = [...candidates].sort((a, b) => a.price - b.price);
  const rawZones = []; const used = new Set();
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const cluster = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(sorted[j].price - sorted[i].price) / sorted[i].price < cfg.levelClusterPct) {
        cluster.push(sorted[j]); used.add(j);
      }
    }
    used.add(i); rawZones.push(cluster);
  }

  // Score each zone with clean touch counting
  const proven = [];
  for (const cluster of rawZones) {
    const zp = cluster.reduce((s, c) => s + c.price, 0) / cluster.length;
    const touches = [];
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      if (Math.abs(c.h - zp) > tz && Math.abs(c.l - zp) > tz && Math.abs(c.c - zp) > tz) continue;
      if (touches.length > 0 && i - touches[touches.length - 1].idx < 3) continue;
      const next = candles.slice(i + 1, i + 5);
      if (!next.length) continue;
      const fromAbove = c.c > zp;
      const rej = fromAbove
        ? (Math.max(...next.map(x => x.h)) - c.l) / atr
        : (c.h - Math.min(...next.map(x => x.l))) / atr;
      if (rej < cfg.levelRejectionMin) continue;
      const age    = n - 1 - i;
      const ageFac = Math.exp(-age / cfg.levelAgHalflife);
      touches.push({ idx: i, fromAbove, rej: +rej.toFixed(2), ageFac: +ageFac.toFixed(3) });
    }
    if (touches.length < cfg.levelMinTouches) continue;
    const fa  = touches.filter(t => t.fromAbove).length;
    const fb  = touches.filter(t => !t.fromAbove).length;
    const rr  = fa > 0 && fb > 0;
    const str = touches.reduce((s, t) => s + t.rej * t.ageFac, 0) * Math.log(touches.length + 1)
              * (rr ? cfg.levelRoleReversalMult : 1);
    proven.push({
      price: +zp.toFixed(1), strength: +str.toFixed(2),
      touchCount: touches.length, hasRoleReversal: rr,
      lastTouchAge: n - 1 - Math.max(...touches.map(t => t.idx)),
      fromAbove: fa, fromBelow: fb, source: 'proven',
    });
  }
  return proven.sort((a, b) => b.strength - a.strength);
}

function classifyLevels(zones, price, atr, cfg) {
  const buf = atr * 0.3;
  return {
    supports:    zones.filter(z => price > z.price + buf).sort((a, b) => b.price - a.price),
    resistances: zones.filter(z => price < z.price - buf).sort((a, b) => a.price - b.price),
    atLevel:     zones.filter(z => Math.abs(z.price - price) <= atr * cfg.levelTouchZoneAtr),
  };
}

// ═══════════════════════════════════════════════════════════════════
//  BEHAVIOUR ANALYSIS
//  This is the core of the strategy — what is price DOING at the level?
// ═══════════════════════════════════════════════════════════════════

// Detect "struggle" at a level: small candles, indecision, no follow-through
function detectStruggle(candles, atr, cfg) {
  if (!candles || candles.length < cfg.struggleCandles + 1) return null;
  const recent = candles.slice(-cfg.struggleCandles);
  const smallCount = recent.filter(c => (c.h - c.l) < atr * cfg.struggleAtrMult).length;
  const avgRange   = recent.reduce((s, c) => s + (c.h - c.l), 0) / recent.length;
  const prevRange  = candles.slice(-(cfg.struggleCandles * 2), -cfg.struggleCandles)
                       .reduce((s, c) => s + (c.h - c.l), 0) / cfg.struggleCandles;
  const rangeShrink = prevRange > 0 ? avgRange / prevRange : 1;
  if (smallCount >= Math.floor(cfg.struggleCandles * 0.6) && rangeShrink < 0.6) {
    return { type:'STRUGGLE', smallCount, rangeShrink: +rangeShrink.toFixed(2), strength: 1 - rangeShrink };
  }
  return null;
}

// Detect compression: tight small candles before a potential breakout
// This is your "small red candles in downtrend" setup
function detectCompression(candles, atr, cfg) {
  if (!candles || candles.length < cfg.compressionCandles + 2) return null;
  const recent  = candles.slice(-cfg.compressionCandles);
  const bodies  = recent.map(c => Math.abs(c.c - c.o));
  const ranges  = recent.map(c => c.h - c.l);
  const avgBody = bodies.reduce((a, b) => a + b, 0) / bodies.length;
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  // All bodies must be small
  const allSmall = bodies.every(b => b < atr * cfg.compressionAtrMult);
  // Range must be shrinking vs prior
  const priorRange = candles.slice(-(cfg.compressionCandles * 2), -cfg.compressionCandles)
                       .reduce((s, c) => s + (c.h - c.l), 0) / cfg.compressionCandles;
  const isSqueeze  = avgRange < priorRange * 0.55;
  if (allSmall && isSqueeze) {
    // Bias of compression: more red candles = bearish compression
    const bearCount = recent.filter(c => c.c < c.o).length;
    const bullCount = recent.length - bearCount;
    return {
      type: 'COMPRESSION',
      bias: bearCount > bullCount ? 'BEAR' : bullCount > bearCount ? 'BULL' : 'NEUTRAL',
      bearCount, bullCount,
      avgBody: +avgBody.toFixed(2), avgRange: +avgRange.toFixed(2),
      strength: +(1 - avgRange / (priorRange || 1)).toFixed(2),
    };
  }
  return null;
}

// Detect breakout candle: large range, strong body, closes decisively
function detectBreakout(candles, atr, cfg) {
  if (!candles || candles.length < 2) return null;
  const c    = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const range = c.h - c.l;
  const body  = Math.abs(c.c - c.o);
  if (range < atr * cfg.breakoutAtrMult) return null;
  if (body / range < 0.45) return null; // needs strong body
  const dir = c.c > c.o ? 'BULL' : 'BEAR';
  // Breakout from prior range
  const priorHigh = Math.max(...candles.slice(-6, -1).map(x => x.h));
  const priorLow  = Math.min(...candles.slice(-6, -1).map(x => x.l));
  const breakingUp   = c.c > priorHigh;
  const breakingDown = c.c < priorLow;
  if (!breakingUp && !breakingDown) return null;
  return {
    type: 'BREAKOUT', dir,
    breakingUp, breakingDown,
    range: +range.toFixed(1), body: +body.toFixed(1),
    strength: +(body / (atr || 1)).toFixed(2),
  };
}

// Strength signal at bottom: absorption + bullish delta + strong close
function detectBottomStrength(candles, micro, atr) {
  if (!candles || candles.length < 3) return null;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body  = Math.abs(last.c - last.o);
  const range = last.h - last.l || 1;
  // Strong bullish close after down move
  const prevDown   = prev.c < prev.o;
  const strongClose = last.c > last.o && body / range > 0.55 && last.c > prev.c;
  // Micro confirmation: buyers showing up
  const microBull  = micro?.bias === 'BUY' || micro?.deltaRatio > 0.1;
  const absorbed   = micro?.absorbed;
  if (strongClose && (microBull || absorbed)) {
    return {
      type: 'BOTTOM_STRENGTH',
      strongClose, microBull, absorbed,
      bodyRatio: +(body / range).toFixed(2),
    };
  }
  return null;
}

// Weakness signal at support: failed bounce, continuing down
function detectSupportWeakness(candles, micro, atr) {
  if (!candles || candles.length < 4) return null;
  const recent = candles.slice(-3);
  // Small candles or red closes at support = weakness
  const allSmallOrRed = recent.every(c => (c.h - c.l) < atr * 0.6 || c.c < c.o);
  const microbear = micro?.bias === 'SELL' || micro?.deltaRatio < -0.1;
  if (allSmallOrRed && microbear) {
    return { type: 'SUPPORT_WEAKNESS', allSmallOrRed, microbear };
  }
  return null;
}

// ── Candle pattern ────────────────────────────────────────────────
function detectPattern(candles) {
  if (!candles || candles.length < 3) return null;
  const c = candles[candles.length - 1], p = candles[candles.length - 2];
  const range = (c.h - c.l) || 0.001, body = Math.abs(c.c - c.o);
  const uw = c.h - Math.max(c.c, c.o), lw = Math.min(c.c, c.o) - c.l;
  if (uw / range > 0.55 && body / range < 0.35 && c.c < p.c)
    return { dir:'bear', label:'Bearish pin', conf:Math.round(uw/range*100) };
  if (lw / range > 0.55 && body / range < 0.35 && c.c > p.c)
    return { dir:'bull', label:'Bullish pin', conf:Math.round(lw/range*100) };
  if (p.c > p.o && c.c < c.o && c.o >= p.c && c.c <= p.o)
    return { dir:'bear', label:'Bearish engulf', conf:80 };
  if (p.c < p.o && c.c > c.o && c.o <= p.c && c.c >= p.o)
    return { dir:'bull', label:'Bullish engulf', conf:80 };
  return null;
}

// ── Liquidity sweep ───────────────────────────────────────────────
function detectSweep(candles, zones, atr, cfg) {
  if (!candles || candles.length < 4 || !atr || !zones.length) return null;
  const last = candles[candles.length - 1], prev = candles[candles.length - 2];
  const buf  = atr * cfg.sweepBufferAtr;
  for (const z of zones.filter(z => z.touchCount >= 2)) {
    if (prev.h > z.price + buf && prev.c < z.price && last.c < last.o) {
      const bp = Math.abs(last.c - last.o) / ((last.h - last.l) || 1);
      if (bp > cfg.sweepBodyPct) return { type:'BEAR_SWEEP', direction:'SELL', level:z,
        note:`Swept $${z.price.toFixed(0)} (${z.touchCount}t)→short`, conf:Math.min(95,60+z.touchCount*7) };
    }
    if (prev.l < z.price - buf && prev.c > z.price && last.c > last.o) {
      const bp = Math.abs(last.c - last.o) / ((last.h - last.l) || 1);
      if (bp > cfg.sweepBodyPct) return { type:'BULL_SWEEP', direction:'BUY', level:z,
        note:`Swept $${z.price.toFixed(0)} (${z.touchCount}t)→long`, conf:Math.min(95,60+z.touchCount*7) };
    }
  }
  return null;
}

// ── Microstructure ────────────────────────────────────────────────
function runMicro(trades, orderBook, cfg) {
  const empty = { delta:0, deltaRatio:0, buyVol:0, sellVol:0, obImbalance:0,
    score:0, bias:'NEUTRAL', recentTrades:0, absorbed:false, divergence:null,
    ok:false, raw:'no trades' };
  if (!trades?.length) return empty;
  const now    = Date.now();
  const recent = trades.filter(t => t.tms && (now - t.tms) <= cfg.microWindowMs);
  if (!recent.length) return { ...empty, raw:`0 in window (last tms ${now-(trades[0]?.tms||0)}ms ago)` };
  let bv = 0, sv = 0;
  for (const t of recent) {
    const sz = parseFloat(t.size) || 0;
    if (t.side === 'buy') bv += sz; else sv += sz;
  }
  const delta = bv - sv, tot = bv + sv || 1, dr = delta / tot;
  const bids = (orderBook?.bids||[]).slice(0,15), asks = (orderBook?.asks||[]).slice(0,15);
  const bw = bids.reduce((s,b)=>s+(parseFloat(b[1])||0),0);
  const aw = asks.reduce((s,a)=>s+(parseFloat(a[1])||0),0);
  const obi = (bw-aw)/((bw+aw)||1);
  const score = dr * 0.6 + obi * 0.4;
  const prices = recent.map(t=>t.price).filter(Boolean);
  const pm = prices.length>1 ? Math.abs(prices[0]-prices[prices.length-1])/(prices[prices.length-1]||1) : 0;
  const absorbed = tot >= cfg.microAbsorbVolMin && pm < 0.0008;
  let divergence = null;
  if (recent.length >= 6) {
    const mid = Math.floor(recent.length/2);
    let dO=0, dN=0;
    for(const t of recent.slice(mid))  { const s=parseFloat(t.size)||0; dO+=t.side==='buy'?s:-s; }
    for(const t of recent.slice(0,mid)) { const s=parseFloat(t.size)||0; dN+=t.side==='buy'?s:-s; }
    const up = recent[0].price > recent[recent.length-1].price;
    if ( up && dN < dO) divergence = 'BEARISH_DIV';
    if (!up && dN > dO) divergence = 'BULLISH_DIV';
  }
  return {
    delta:+delta.toFixed(2), deltaRatio:+dr.toFixed(3),
    buyVol:+bv.toFixed(2), sellVol:+sv.toFixed(2),
    obImbalance:+obi.toFixed(3), score:+score.toFixed(3),
    absorbed, divergence,
    bias: score > cfg.microBiasThresh ? 'BUY' : score < -cfg.microBiasThresh ? 'SELL' : 'NEUTRAL',
    recentTrades: recent.length, ok: recent.length >= 3,
    raw:`${recent.length}t buy=${bv.toFixed(1)} sell=${sv.toFixed(1)} δ=${dr.toFixed(3)}`,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  SETUP EVALUATORS  (the 3 core setups)
// ═══════════════════════════════════════════════════════════════════

// Setup 1: Proven High Rejection (SHORT)
// Macro trend DOWN or NEUTRAL · price at proven resistance · struggle/rejection behaviour
function evalProvenHighRejection(candles, markPrice, macro, atLevel, supports, resistances, atr, micro, cfg) {
  // Don't short into a strong uptrend
  if (macro?.dir === 'UP' && macro.strong) return null;

  const level = atLevel.find(z => z.price >= markPrice * 0.998);
  if (!level || level.touchCount < cfg.levelMinTouches) return null;

  const struggle  = detectStruggle(candles, atr, cfg);
  const pattern   = detectPattern(candles);
  const bearPat   = pattern?.dir === 'bear';
  const microBear = micro?.bias === 'SELL' || micro?.deltaRatio < -0.05;
  const divBear   = micro?.divergence === 'BEARISH_DIV';

  // Need at least: struggle OR bearish pattern OR bearish OFD
  const signals = [struggle ? 1:0, bearPat ? 1:0, microBear ? 1:0, divBear ? 1:0];
  const sigCount = signals.reduce((a,b)=>a+b,0);
  if (sigCount < 2) return null;

  // Score: level strength + signal count + macro alignment
  const score = level.strength * 15
    + level.touchCount * 8
    + sigCount * 15
    + (macro?.dir === 'DOWN' ? 20 : 0)
    + (divBear ? 15 : 0)
    + (struggle ? struggle.strength * 20 : 0);

  // TP = nearest support below, SL = just above the resistance level
  const tp = supports[0]?.price;
  const sl = level.price + atr * 0.4;
  if (!tp || sl <= markPrice) return null;
  const rr = (markPrice - tp) / (sl - markPrice);
  if (rr < cfg.minRR) return null;

  return {
    setup: 'PROVEN_HIGH_REJECTION', signal: 'SELL',
    score: +score.toFixed(1), rr: +rr.toFixed(2),
    tp: +tp.toFixed(1), sl: +sl.toFixed(1),
    level, struggle, pattern, microBear, divBear,
    reason: `Proven resistance $${level.price.toFixed(0)} (${level.touchCount}t)` +
      `${struggle?' · struggle':''}${bearPat?' · '+pattern.label:''}` +
      `${divBear?' · OFD bear':''}${macro?.dir==='DOWN'?' · macro DOWN':''}`,
  };
}

// Setup 2: Compression Breakdown (SHORT continuation)
// Market in downtrend · hits support that shows weakness · small candles · then breakdown
function evalCompressionBreakdown(candles, markPrice, macro, atLevel, supports, resistances, atr, micro, cfg) {
  // Need downtrend or neutral trend
  if (macro?.dir === 'UP' && macro.strong) return null;

  const comp    = detectCompression(candles, atr, cfg);
  if (!comp || comp.bias === 'BULL') return null; // need bearish or neutral compression

  const breakout = detectBreakout(candles, atr, cfg);
  const supportWeak = atLevel.length > 0
    ? detectSupportWeakness(candles, micro, atr)
    : null;

  // Case A: compression at a proven level + weakness → continuation likely
  const levelWeak = atLevel.find(z => z.touchCount >= cfg.levelMinTouches);

  // Score
  let score = comp.strength * 30 + (comp.bias === 'BEAR' ? 25 : 0);
  if (breakout?.dir === 'BEAR') score += breakout.strength * 20;
  if (supportWeak) score += 20;
  if (macro?.dir === 'DOWN') score += 20;
  if (levelWeak) score += levelWeak.strength * 10;
  if (score < 40) return null;

  // TP = next support below (compression releases to next level)
  const tp = supports[0]?.price;
  const sl = Math.max(...candles.slice(-cfg.compressionCandles).map(c => c.h)) + atr * 0.3;
  if (!tp) return null;
  const rr = (markPrice - tp) / (sl - markPrice);
  if (rr < cfg.minRR || sl <= markPrice) return null;

  return {
    setup: 'COMPRESSION_BREAKDOWN', signal: 'SELL',
    score: +score.toFixed(1), rr: +rr.toFixed(2),
    tp: +tp.toFixed(1), sl: +sl.toFixed(1),
    comp, breakout, supportWeak, levelWeak,
    reason: `Compression ${comp.bias} (${comp.bearCount}/${candles.slice(-cfg.compressionCandles).length} red)` +
      `${breakout?.dir==='BEAR'?' · breakdown candle':''}` +
      `${supportWeak?' · support weak':''}` +
      `${macro?.dir==='DOWN'?' · macro DOWN':''}`,
  };
}

// Setup 3: Bottom Recovery (LONG)
// Market at proven support · shows strength (absorption, bullish delta, strong close)
function evalBottomRecovery(candles, markPrice, macro, atLevel, supports, resistances, atr, micro, cfg) {
  // Don't buy into strong downtrend
  if (macro?.dir === 'DOWN' && macro.strong) return null;

  const level = atLevel.find(z => z.price <= markPrice * 1.002 && z.touchCount >= cfg.levelMinTouches);
  if (!level) return null;

  const strength = detectBottomStrength(candles, micro, atr);
  const sweep    = detectSweep(candles, atLevel, atr, cfg);
  const pattern  = detectPattern(candles);
  const bullPat  = pattern?.dir === 'bull';
  const microBull = micro?.bias === 'BUY' || micro?.deltaRatio > 0.05;
  const divBull  = micro?.divergence === 'BULLISH_DIV';

  // Must have strength confirmation — we do NOT enter on a falling knife
  const signals = [strength ? 1:0, bullPat ? 1:0, microBull ? 1:0, divBull ? 1:0, sweep?.direction==='BUY' ? 1:0];
  const sigCount = signals.reduce((a,b)=>a+b,0);
  if (sigCount < 2) return null;

  const score = level.strength * 15
    + level.touchCount * 8
    + sigCount * 15
    + (macro?.dir === 'UP' ? 20 : 0)
    + (divBull ? 15 : 0)
    + (strength ? strength.bodyRatio * 20 : 0)
    + (sweep ? 15 : 0);

  // TP = nearest resistance above, SL = just below the support level
  const tp = resistances[0]?.price;
  const sl = level.price - atr * 0.4;
  if (!tp || sl >= markPrice) return null;
  const rr = (tp - markPrice) / (markPrice - sl);
  if (rr < cfg.minRR) return null;

  return {
    setup: 'BOTTOM_RECOVERY', signal: 'BUY',
    score: +score.toFixed(1), rr: +rr.toFixed(2),
    tp: +tp.toFixed(1), sl: +sl.toFixed(1),
    level, strength, pattern, microBull, divBull, sweep,
    reason: `Proven support $${level.price.toFixed(0)} (${level.touchCount}t)` +
      `${strength?' · strong close':''}${bullPat?' · '+pattern.label:''}` +
      `${divBull?' · OFD bull':''}${sweep?' · sweep low':''}` +
      `${macro?.dir==='UP'?' · macro UP':''}`,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  MASTER SIGNAL EVALUATOR
// ═══════════════════════════════════════════════════════════════════

function isLastCandleClosed(candles) {
  if (!candles || candles.length < 2) return false;
  const last = candles[candles.length - 1];
  if (last.live === true)  return false;
  if (last.live === false) return true;
  return true;
}

function evaluateAll(candles, markPrice, trades, orderBook, allZones, macro, cfg) {
  if (!candles || candles.length < 50 || !markPrice) return null;
  if (!isLastCandleClosed(candles)) return { signal:'HOLD', reason:'Candle still forming', setup:null };

  const atr        = calcATR(candles);
  if (!atr) return null;
  const micro      = runMicro(trades, orderBook, cfg);
  const { supports, resistances, atLevel } = classifyLevels(allZones, markPrice, atr, cfg);

  // Evaluate all 3 setups
  const r1 = evalProvenHighRejection(candles, markPrice, macro, atLevel, supports, resistances, atr, micro, cfg);
  const r2 = evalCompressionBreakdown(candles, markPrice, macro, atLevel, supports, resistances, atr, micro, cfg);
  const r3 = evalBottomRecovery(candles, markPrice, macro, atLevel, supports, resistances, atr, micro, cfg);

  // Also check sweep on all zones
  const sweep = detectSweep(candles, atLevel.length ? atLevel : allZones.slice(0,10), atr, cfg);

  // Pick highest scoring valid setup
  const candidates = [r1, r2, r3].filter(Boolean).sort((a,b) => b.score - a.score);

  if (!candidates.length && !sweep) {
    // Describe what we're watching
    const watching = atLevel.length
      ? `At $${atLevel[0].price.toFixed(0)} (${atLevel[0].touchCount}t) — watching for behaviour`
      : `Next res $${resistances[0]?.price.toFixed(0)||'—'} · next sup $${supports[0]?.price.toFixed(0)||'—'}`;
    return { signal:'HOLD', reason:watching, setup:null, micro, macro, atLevel, supports, resistances };
  }

  // Sweep override
  if (sweep && (!candidates[0] || sweep.conf > candidates[0].score * 0.6)) {
    const tp   = sweep.direction==='SELL' ? supports[0]?.price : resistances[0]?.price;
    const slLv = sweep.direction==='SELL' ? sweep.level.price + atr*0.4 : sweep.level.price - atr*0.4;
    if (tp) {
      const rr = sweep.direction==='SELL'
        ? (markPrice-tp)/(slLv-markPrice)
        : (tp-markPrice)/(markPrice-slLv);
      if (rr >= cfg.minRRSweep) {
        return {
          signal: sweep.direction, setup:'SWEEP', score: sweep.conf,
          rr: +rr.toFixed(2), tp: +tp.toFixed(1), sl: +slLv.toFixed(1),
          reason: sweep.note, sweep, micro, macro, atLevel, supports, resistances,
          valid: true,
        };
      }
    }
  }

  const best = candidates[0];
  return { ...best, sweep, micro, macro, atLevel, supports, resistances, valid: true };
}

// ═══════════════════════════════════════════════════════════════════
//  BACKTESTING ENGINE
// ═══════════════════════════════════════════════════════════════════

function runBacktest(candles, cfg, addLog) {
  if (!candles || candles.length < 200) {
    addLog(`Not enough candles for backtest (${candles.length})`, 'warn');
    return null;
  }
  let equity = 10000, peak = 10000, maxDD = 0, wins = 0, losses = 0;
  let totalRR = 0;
  const curve = [];
  const step  = Math.max(1, Math.floor(candles.length / 500));

  for (let i = 150; i < candles.length - 5; i += step) {
    const slice  = candles.slice(0, i);
    const atr    = calcATR(slice); if (!atr) continue;
    const macro  = getMacroTrend(slice, cfg);
    const zones  = buildProvenLevels(slice, cfg); if (!zones.length) continue;
    const result = evaluateAll(slice, slice[slice.length-1].c, [], {}, zones, macro, cfg);
    if (!result?.valid || result.signal==='HOLD') continue;

    let pnl = 0, hit = false;
    for (let j = i; j < Math.min(i + 60, candles.length); j++) {
      const c = candles[j];
      if (result.signal==='BUY') {
        if (c.h >= result.tp) { pnl = result.tp - slice[slice.length-1].c; hit=true; break; }
        if (c.l <= result.sl) { pnl = result.sl - slice[slice.length-1].c; hit=true; break; }
      } else {
        if (c.l <= result.tp) { pnl = slice[slice.length-1].c - result.tp; hit=true; break; }
        if (c.h >= result.sl) { pnl = slice[slice.length-1].c - result.sl; hit=true; break; }
      }
    }
    if (!hit) continue;
    const pnlPct = pnl / slice[slice.length-1].c * 100;
    equity += pnlPct * 100;
    peak    = Math.max(peak, equity);
    maxDD   = Math.max(maxDD, (peak-equity)/peak*100);
    if (pnl>0) {
      wins++;
      totalRR += result.rr || cfg.minRR;
    } else {
      losses++;
      totalRR -= 1;
    }
    curve.push(+equity.toFixed(0));
  }

  const tot = wins+losses;
  const avgWinRR = wins > 0 ? totalRR / wins : 0;
  return {
    trades:tot, wins, losses,
    winRate: tot>0 ? +(wins/tot*100).toFixed(1) : 0,
    finalEquity: +equity.toFixed(0),
    maxDrawdown: +maxDD.toFixed(2),
    profitFactor: losses > 0 ? (wins * avgWinRR) / losses : (wins > 0 ? 999 : 0),
    equityCurve: curve,
  };
}

// ═══════════════════════════════════════════════════════════════════
//  HOOK
// ═══════════════════════════════════════════════════════════════════

export function useTradingBot({ candles, markPrice, trades, orderBook, openPosition, closePosition, positions, log }) {
  const [cfg, setCfg]               = useState(DEFAULT_CONFIG);
  const [running, setRunning]       = useState(false);
  const [lastResult, setLastResult] = useState(null);
  const [stats, setStats]           = useState({ trades:0,wins:0,losses:0,totalPnl:0,sweepTrades:0 });
  const [botLog, setBotLog]         = useState([]);
  const [allZones, setAllZones]     = useState([]);
  const [macro, setMacro]           = useState(null);
  const [levelLog, setLevelLog]     = useState('');
  const [btResult, setBtResult]     = useState(null);
  const [btRunning, setBtRunning]   = useState(false);

  const prevCandleLen  = useRef(0);
  const botPosIdRef    = useRef(null);
  const activeTpRef    = useRef(null);
  const activeSlRef    = useRef(null);
  const activeSideRef  = useRef(null);
  const entryPriceRef  = useRef(null);
  const trailActiveRef = useRef(false);
  const intervalRef    = useRef(null);

  const addLog = useCallback((msg, type='info') => {
    const ts = new Date().toLocaleTimeString();
    setBotLog(l => [{ ts, msg, type }, ...l].slice(0, 150));
    if (log) log(`[BOT] ${msg}`, type);
  }, [log]);

  // Rebuild levels + macro only on new candle
  useEffect(() => {
    if (!candles || candles.length < 30) return;
    if (candles.length === prevCandleLen.current) return;
    prevCandleLen.current = candles.length;
    const zones = buildProvenLevels(candles, cfg);
    setAllZones(zones);
    setMacro(getMacroTrend(candles, cfg));
    const q = zones.filter(z => z.touchCount >= cfg.levelMinTouches);
    setLevelLog(`${zones.length} zones · ${q.length} proven (≥${cfg.levelMinTouches}t) · ${zones.filter(z=>z.hasRoleReversal).length} role-reversed`);
  }, [candles, cfg]);

  const tick = useCallback(() => {
    if (!candles || candles.length < 50 || !markPrice) return;
    const result = evaluateAll(candles, markPrice, trades, orderBook, allZones, macro, cfg);
    if (!result) return;
    setLastResult(result);

    const hasOpenPos = botPosIdRef.current !== null && positions.some(p => p.id === botPosIdRef.current);
    const atr = calcATR(candles);
    const { supports, resistances } = result;

    // Manage open position
    if (hasOpenPos) {
      const pos  = positions.find(p => p.id === botPosIdRef.current);
      if (pos) {
        const side  = activeSideRef.current;
        const entry = entryPriceRef.current || pos.entry;
        // Activate trail
        if (!trailActiveRef.current && atr) {
          if ((side==='buy'?markPrice-entry:entry-markPrice) >= atr*cfg.trailActivateAtr) {
            trailActiveRef.current = true;
            addLog(`Trail activated @ $${markPrice.toFixed(1)}`, 'muted');
          }
        }
        // Update trailing SL
        if (trailActiveRef.current && atr) {
          const nearLv = side==='buy'
            ? resistances?.some(z=>z.touchCount>=cfg.levelMinTouches&&z.price<markPrice+atr*1.5&&z.price>markPrice)
            : supports?.some(z=>z.touchCount>=cfg.levelMinTouches&&z.price>markPrice-atr*1.5&&z.price<markPrice);
          const trail  = ((nearLv ? cfg.trailTightAtr : cfg.trailNormalAtr)) * atr;
          const newSL  = side==='buy' ? markPrice-trail : markPrice+trail;
          if ((side==='buy'&&newSL>activeSlRef.current)||(side==='sell'&&newSL<activeSlRef.current)) {
            activeSlRef.current = +newSL.toFixed(1);
            addLog(`Trail → $${activeSlRef.current}`, 'muted');
          }
        }
        const hitTP = side==='buy'?markPrice>=activeTpRef.current:markPrice<=activeTpRef.current;
        const hitSL = side==='buy'?markPrice<=activeSlRef.current:markPrice>=activeSlRef.current;
        if (hitTP || hitSL) {
          const pnl = side==='buy'?pos.qty*(markPrice-entry):pos.qty*(entry-markPrice);
          closePosition(botPosIdRef.current);
          setStats(s=>({...s,trades:s.trades+1,wins:pnl>0?s.wins+1:s.wins,losses:pnl<=0?s.losses+1:s.losses,totalPnl:s.totalPnl+pnl}));
          addLog(`EXIT [${hitTP?'TP':'SL'}] ${pnl>=0?'+':''}$${pnl.toFixed(2)} @ $${markPrice.toFixed(1)}`, pnl>0?'success':'danger');
          botPosIdRef.current=null; activeTpRef.current=null; activeSlRef.current=null;
          activeSideRef.current=null; entryPriceRef.current=null; trailActiveRef.current=false;
        }
      }
    }

    // Enter new position
    if (!hasOpenPos && result.valid && result.signal!=='HOLD') {
      const side = result.signal==='BUY'?'buy':'sell';
      openPosition(side, null);
      botPosIdRef.current   = Date.now();
      activeTpRef.current   = result.tp;
      activeSlRef.current   = result.sl;
      activeSideRef.current = side;
      entryPriceRef.current = markPrice;
      trailActiveRef.current = false;
      if (result.setup==='SWEEP') setStats(s=>({...s,sweepTrades:s.sweepTrades+1}));
      addLog(`${result.signal} [${result.setup}] Score:${result.score} R:R:${result.rr}`, side==='buy'?'success':'warn');
      addLog(`  ${result.reason}`, 'muted');
      addLog(`  TP:$${result.tp} SL:$${result.sl}`, 'muted');
    }
  }, [candles, markPrice, trades, orderBook, allZones, macro, cfg, openPosition, closePosition, positions, addLog]);

  useEffect(() => {
    if (running) { intervalRef.current = setInterval(tick, 4000); }
    else clearInterval(intervalRef.current);
    return () => clearInterval(intervalRef.current);
  }, [running, tick]);

  const startBacktest = useCallback(async () => {
    const analysisCandles = candles.slice(-1200);
    if (!analysisCandles || analysisCandles.length < 80) { addLog('Need ≥80 candles for backtest','warn'); return; }
    setBtRunning(true); setBtResult(null);
    addLog(`Backtesting ${analysisCandles.length} candles…`,'info');
    await new Promise(r => setTimeout(r, 20));
    try {
      const res = runBacktest(analysisCandles, cfg, addLog);
      setBtResult(res);
      addLog(`Done · ${res.trades}t · WR ${res.winRate}% · DD ${res.maxDrawdown}%`, res.winRate>=50?'success':'warn');
    } catch(e) { addLog(`BT error: ${e.message}`,'danger'); }
    setBtRunning(false);
  }, [candles, cfg, addLog]);

  const start = useCallback(() => { setRunning(true); addLog('v8 started · 3 setups: ProvenHigh · Compression · BottomRecovery','success'); }, [addLog]);
  const stop  = useCallback(() => { setRunning(false); addLog('Stopped','warn'); }, [addLog]);
  const reset = useCallback(() => {
    setRunning(false); setStats({trades:0,wins:0,losses:0,totalPnl:0,sweepTrades:0}); setBotLog([]);
    botPosIdRef.current=null; activeTpRef.current=null; activeSlRef.current=null;
    activeSideRef.current=null; entryPriceRef.current=null; trailActiveRef.current=false;
    addLog('Reset','muted');
  }, [addLog]);

  const winRate = (stats.wins+stats.losses)>0?Math.round(stats.wins/(stats.wins+stats.losses)*100):null;

  return { running, lastResult, stats, botLog, winRate, allZones, macro, levelLog,
           cfg, setCfg, btResult, btRunning, startBacktest, start, stop, reset };
}

// ═══════════════════════════════════════════════════════════════════
//  PANEL UI
// ═══════════════════════════════════════════════════════════════════

const SIG_COLOR  = { BUY:'#00ffe1', SELL:'#ff7ab0', HOLD:'#94a3b8' };
const SIG_BG     = { BUY:'rgba(0,255,209,0.07)', SELL:'rgba(255,92,158,0.07)', HOLD:'rgba(148,163,184,0.04)' };
const SIG_BORDER = { BUY:'rgba(0,255,209,0.2)',  SELL:'rgba(255,92,158,0.2)',  HOLD:'rgba(148,163,184,0.08)' };
const SETUP_COL  = {
  PROVEN_HIGH_REJECTION:'#ff7ab0', COMPRESSION_BREAKDOWN:'#f87171',
  BOTTOM_RECOVERY:'#00ffe1', SWEEP:'#fbbf24',
};
const MACRO_COL  = { UP:'#34d399', DOWN:'#f87171', NEUTRAL:'#94a3b8' };

function CfgRow({ label, k, cfg, setCfg, step=0.1, min=0, max=20 }) {
  return (
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'2px 0' }}>
      <span style={{ fontSize:10, color:'#5b7e93' }}>{label}</span>
      <input type="number" step={step} min={min} max={max} value={cfg[k]}
        onChange={e => setCfg(c=>({...c,[k]:parseFloat(e.target.value)||0}))}
        style={{ width:60, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)',
          color:'#e6faff', borderRadius:4, padding:'2px 5px', fontSize:10, textAlign:'right', fontFamily:'inherit' }}/>
    </div>
  );
}

export const BotPanel = forwardRef(function BotPanel(
  { candles, markPrice, trades, orderBook, openPosition, closePosition, positions, log }, ref
) {
  const bot = useTradingBot({ candles, markPrice, trades, orderBook, openPosition, closePosition, positions, log });
  const { running, lastResult, stats, botLog, winRate, allZones, macro, levelLog,
          cfg, setCfg, btResult, btRunning, startBacktest, start, stop, reset } = bot;
  useImperativeHandle(ref, () => ({ start, stop, reset }), [start, stop, reset]);

  const [tab, setTab] = useState('main');
  const sig = lastResult?.signal || 'HOLD';
  const atr = useMemo(() => calcATR(candles), [candles]);
  const { supports=[], resistances=[], atLevel=[] } = lastResult || {};

  const tb = (t, lbl) => (
    <button className={`btn ${tab===t?'btn-on':''}`}
      style={{ flex:1, fontSize:10, padding:'3px 0' }} onClick={()=>setTab(t)}>{lbl}</button>
  );

  return (
    <div style={{ display:'flex', flexDirection:'column' }}>
      <div className="phdr" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span>Bot v8</span>
        <div style={{ display:'flex', alignItems:'center', gap:5 }}>
          {lastResult?.setup && sig!=='HOLD' && (
            <span style={{ fontSize:9, fontWeight:700, color:SETUP_COL[lastResult.setup]||'#94a3b8',
              background:'rgba(255,255,255,0.04)', padding:'1px 6px', borderRadius:10 }}>
              {lastResult.setup?.replace(/_/g,' ')}
            </span>
          )}
          <div style={{ width:6, height:6, borderRadius:'50%', background:running?'#34d399':'#475569',
            boxShadow:running?'0 0 5px #34d399':'none', animation:running?'pulse 1.8s infinite':'none' }}/>
        </div>
      </div>

      <div style={{ padding:'5px 8px', display:'flex', gap:3 }}>
        {tb('main','Signal')} {tb('levels','Levels')} {tb('config','Config')} {tb('backtest','Backtest')}
      </div>

      <div style={{ padding:'0 10px 10px', display:'flex', flexDirection:'column', gap:6 }}>

        {/* ── MAIN ─────────────────────────────────────────────── */}
        {tab==='main' && (<>
          {levelLog && <div style={{ fontSize:9, color:'#334155', padding:'2px 6px',
            background:'rgba(0,0,0,0.15)', borderRadius:4, lineHeight:1.5 }}>{levelLog}</div>}

          {/* Sweep alert */}
          {lastResult?.sweep && (
            <div style={{ padding:'5px 9px', borderRadius:7, fontSize:11, fontWeight:700,
              background:'rgba(251,191,36,0.1)', border:'1px solid rgba(251,191,36,0.3)', color:'#fbbf24' }}>
              SWEEP · {lastResult.sweep.type} · {lastResult.sweep.conf}%
              <div style={{ fontSize:9, fontWeight:400, color:'#856c1a', marginTop:1 }}>{lastResult.sweep.note}</div>
            </div>
          )}

          {/* OFD */}
          {lastResult?.micro?.divergence && (
            <div style={{ padding:'3px 8px', borderRadius:5, fontSize:10, fontWeight:700,
              background:lastResult.micro.divergence==='BULLISH_DIV'?'rgba(0,255,209,0.06)':'rgba(255,92,158,0.06)',
              border:`1px solid ${lastResult.micro.divergence==='BULLISH_DIV'?'rgba(0,255,209,0.18)':'rgba(255,92,158,0.18)'}`,
              color:lastResult.micro.divergence==='BULLISH_DIV'?'#00ffe1':'#ff7ab0' }}>
              OFD · {lastResult.micro.divergence.replace('_DIV','').replace('_',' ')}
            </div>
          )}

          {/* Signal + macro + score */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:5 }}>
            <div style={{ background:SIG_BG[sig], border:`1px solid ${SIG_BORDER[sig]}`, borderRadius:8, padding:'7px 9px' }}>
              <div style={{ fontSize:9, color:'#475569' }}>Signal</div>
              <div style={{ fontWeight:800, fontSize:18, color:SIG_COLOR[sig] }}>{sig}</div>
              <div style={{ fontSize:9, color:SETUP_COL[lastResult?.setup]||'#334155', marginTop:1 }}>
                {lastResult?.setup?.replace(/_/g,' ')||'HOLD'}
              </div>
            </div>
            <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.04)', borderRadius:8, padding:'7px 9px' }}>
              <div style={{ fontSize:9, color:'#475569' }}>Macro</div>
              <div style={{ fontWeight:800, fontSize:16, color:MACRO_COL[macro?.dir]||'#94a3b8' }}>{macro?.dir||'—'}</div>
              <div style={{ fontSize:9, color:macro?.strong?MACRO_COL[macro.dir]:'#334155' }}>
                {macro?.strong?'STRONG':'weak'} · str={macro?.structureBias||'—'}
              </div>
            </div>
            <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.04)', borderRadius:8, padding:'7px 9px' }}>
              <div style={{ fontSize:9, color:'#475569' }}>Score/R:R</div>
              <div style={{ fontWeight:800, fontSize:16, color:(lastResult?.score||0)>60?'#00ffe1':'#94a3b8' }}>
                {lastResult?.score??'—'}
              </div>
              <div style={{ fontSize:9, color:lastResult?.rr>=2?'#34d399':lastResult?.rr>=1.5?'#fbbf24':'#94a3b8' }}>
                R:R {lastResult?.rr??'—'}
              </div>
            </div>
          </div>

          {/* At level */}
          {atLevel.length>0 && (
            <div style={{ padding:'4px 9px', borderRadius:6, fontSize:10, fontWeight:700,
              background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.18)', color:'#fbbf24' }}>
              AT LEVEL: {atLevel.slice(0,3).map(z=>`$${z.price.toFixed(0)} [${z.touchCount}t${z.hasRoleReversal?' ⇄':''}]`).join(' · ')}
            </div>
          )}

          {/* Reason */}
          {lastResult?.reason && (
            <div style={{ fontSize:10, color:'#5b7e93', background:'rgba(0,0,0,0.18)',
              padding:'5px 8px', borderRadius:5, lineHeight:1.7 }}>{lastResult.reason}</div>
          )}

          {/* TP/SL */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:5 }}>
            {[['TP (level)', lastResult?.tp, '#34d399'],
              ['Trail SL', lastResult?.sl, '#f87171'],
              ['R:R', lastResult?.rr, lastResult?.rr>=2?'#34d399':lastResult?.rr>=1.5?'#fbbf24':'#f87171']].map(([l,v,c])=>(
              <div key={l} style={{ borderRadius:6, padding:'5px 6px', textAlign:'center',
                background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.04)' }}>
                <div style={{ fontSize:9, color:'#475569' }}>{l}</div>
                <div style={{ fontSize:12, fontWeight:700, color:c }}>{v!=null?`$${v}`:'—'}</div>
              </div>
            ))}
          </div>

          {/* Behaviour summary */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
            {[
              ['Compression', lastResult?.comp, lastResult?.comp?.bias==='BEAR'?'#f87171':lastResult?.comp?.bias==='BULL'?'#34d399':'#94a3b8'],
              ['Struggle',    lastResult?.struggle, '#fbbf24'],
              ['Strength',    lastResult?.strength, '#34d399'],
              ['Micro',       lastResult?.micro, lastResult?.micro?.bias==='BUY'?'#34d399':lastResult?.micro?.bias==='SELL'?'#f87171':'#94a3b8'],
            ].map(([lbl, obj, col])=> obj ? (
              <div key={lbl} style={{ background:'rgba(255,255,255,0.02)', borderRadius:6, padding:'5px 7px',
                border:`1px solid ${col}22` }}>
                <div style={{ fontSize:9, color:'#475569' }}>{lbl}</div>
                <div style={{ fontSize:11, fontWeight:700, color:col }}>
                  {lbl==='Compression' ? `${obj.bias} ${obj.bearCount}/${obj.bearCount+obj.bullCount}` :
                   lbl==='Struggle'    ? `str ${obj.strength?.toFixed(2)}` :
                   lbl==='Strength'    ? `body ${(obj.bodyRatio*100).toFixed(0)}%` :
                   `${obj.bias} n=${obj.recentTrades}`}
                </div>
              </div>
            ) : null)}
          </div>

          {/* Micro raw */}
          {lastResult?.micro?.raw && (
            <div style={{ fontSize:9, color:'#2d4a5e', padding:'2px 6px' }}>{lastResult.micro.raw}</div>
          )}

          {/* Stats */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:3 }}>
            {[['Trades',stats.trades,'#9ddfff'],['Wins',stats.wins,'#34d399'],['Loss',stats.losses,'#f87171'],
              ['Win%',winRate!=null?`${winRate}%`:'—',winRate!=null?(winRate>=50?'#34d399':'#f87171'):'#94a3b8'],
              ['Sweeps',stats.sweepTrades,'#fbbf24']].map(([l,v,c])=>(
              <div key={l} style={{ background:'rgba(255,255,255,0.02)', borderRadius:5, padding:'3px',
                textAlign:'center', border:'1px solid rgba(255,255,255,0.03)' }}>
                <div style={{ fontSize:9, color:'#475569', marginBottom:1 }}>{l}</div>
                <div style={{ fontSize:12, fontWeight:800, color:c }}>{v}</div>
              </div>
            ))}
          </div>
          <div style={{ display:'flex', justifyContent:'space-between' }}>
            <span style={{ fontSize:11, color:'#94a3b8' }}>Total PnL</span>
            <span style={{ fontWeight:800, fontSize:15, color:stats.totalPnl>=0?'#00ffe1':'#ff7ab0' }}>
              {stats.totalPnl>=0?'+':''}${stats.totalPnl.toFixed(2)}</span>
          </div>
          <div style={{ display:'flex', gap:6 }}>
            {!running
              ? <button className="btn btn-green" style={{ flex:1, fontSize:11 }} onClick={start}>▶ Start</button>
              : <button className="btn btn-red"   style={{ flex:1, fontSize:11 }} onClick={stop}>■ Stop</button>}
            <button className="btn" style={{ fontSize:11 }} onClick={reset}>Reset</button>
          </div>
        </>)}

        {/* ── LEVELS ───────────────────────────────────────────── */}
        {tab==='levels' && (<>
          <div style={{ fontSize:9, color:'#475569', lineHeight:1.6 }}>
            {levelLog} · ⇄ role-reversed · Macro: <span style={{ color:MACRO_COL[macro?.dir]||'#94a3b8' }}>{macro?.dir||'—'} {macro?.strong?'STRONG':''}</span>
          </div>
          {macro && (
            <div style={{ background:'rgba(255,255,255,0.02)', borderRadius:6, padding:'6px 9px', border:'1px solid rgba(255,255,255,0.03)', fontSize:10 }}>
              <div style={{ color:'#475569', marginBottom:3 }}>Market structure</div>
              <div style={{ display:'flex', gap:10 }}>
                <span style={{ color:'#94a3b8' }}>EMA50 <b style={{ color:MACRO_COL[macro.dir] }}>${macro.ema50}</b></span>
                <span style={{ color:'#94a3b8' }}>EMA200 <b style={{ color:'#e6faff' }}>{macro.ema200?`$${macro.ema200}`:'n/a'}</b></span>
                <span style={{ color:'#94a3b8' }}>Str <b style={{ color:MACRO_COL[macro.structureBias] }}>{macro.structureBias}</b></span>
              </div>
            </div>
          )}
          {[['↑ RESISTANCE (acts as ceiling)', resistances||[], '#f87171'],
            ['↓ SUPPORT (acts as floor)',       supports||[],    '#34d399']].map(([t,zs,col])=>(
            <div key={t}>
              <div style={{ fontSize:9, color:col, marginBottom:3 }}>{t}</div>
              {zs.length===0 && <div style={{ fontSize:10, color:'#334155' }}>None detected</div>}
              {zs.slice(0,8).map((z,i)=>(
                <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:11,
                  padding:'3px 0', borderBottom:'1px solid rgba(255,255,255,0.025)',
                  color:i===0?col:'#7f9fb5', fontWeight:i===0?700:400 }}>
                  <span>${z.price.toFixed(1)} {z.hasRoleReversal?'⇄':''} {z.touchCount<cfg.levelMinTouches?'(weak)':''}</span>
                  <span style={{ fontSize:9, color:'#334155' }}>{z.touchCount}t str:{z.strength.toFixed(1)}</span>
                </div>
              ))}
            </div>
          ))}
        </>)}

        {/* ── CONFIG ───────────────────────────────────────────── */}
        {tab==='config' && (<>
          <div style={{ fontSize:9, color:'#475569', marginBottom:2 }}>Level quality</div>
          <CfgRow label="Min touches" k="levelMinTouches" cfg={cfg} setCfg={setCfg} step={1} min={2} max={8}/>
          <CfgRow label="Touch zone ATR×" k="levelTouchZoneAtr" cfg={cfg} setCfg={setCfg} step={0.1} min={0.3} max={2}/>
          <CfgRow label="Min rejection ATR×" k="levelRejectionMin" cfg={cfg} setCfg={setCfg} step={0.05} min={0.1} max={2}/>
          <CfgRow label="Age half-life (candles)" k="levelAgHalflife" cfg={cfg} setCfg={setCfg} step={10} min={20} max={300}/>
          <div style={{ fontSize:9, color:'#475569', marginTop:5, marginBottom:2 }}>Behaviour</div>
          <CfgRow label="Struggle candles" k="struggleCandles" cfg={cfg} setCfg={setCfg} step={1} min={2} max={10}/>
          <CfgRow label="Struggle ATR×" k="struggleAtrMult" cfg={cfg} setCfg={setCfg} step={0.05} min={0.1} max={1}/>
          <CfgRow label="Compression candles" k="compressionCandles" cfg={cfg} setCfg={setCfg} step={1} min={3} max={12}/>
          <CfgRow label="Compression ATR×" k="compressionAtrMult" cfg={cfg} setCfg={setCfg} step={0.05} min={0.1} max={1}/>
          <div style={{ fontSize:9, color:'#475569', marginTop:5, marginBottom:2 }}>Trade management</div>
          <CfgRow label="Min R:R" k="minRR" cfg={cfg} setCfg={setCfg} step={0.1} min={1} max={5}/>
          <CfgRow label="Trail normal ATR×" k="trailNormalAtr" cfg={cfg} setCfg={setCfg} step={0.1} min={0.5} max={5}/>
          <CfgRow label="Trail tight ATR×" k="trailTightAtr" cfg={cfg} setCfg={setCfg} step={0.1} min={0.3} max={3}/>
          <button className="btn" style={{ fontSize:10, marginTop:5 }} onClick={()=>setCfg(DEFAULT_CONFIG)}>Reset defaults</button>
        </>)}

        {/* ── BACKTEST ─────────────────────────────────────────── */}
        {tab==='backtest' && (<>
          <div style={{ fontSize:10, color:'#5b7e93', lineHeight:1.6 }}>
            Walk-forward on current candle history. Uses all 3 setups with active config. No live microstructure.
          </div>
          <button className="btn btn-green" style={{ fontSize:11 }} onClick={startBacktest} disabled={btRunning}>
            {btRunning?'⟳ Running…':`▶ Run (${Math.min(candles?.length||0, 1200)} candles)`}
          </button>
          {btResult && (
            <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
                {[['Trades',btResult.trades,'#9ddfff'],
                  ['Win rate',`${btResult.winRate}%`,btResult.winRate>=50?'#34d399':'#f87171'],
                  ['Profit factor',btResult.profitFactor??'—',btResult.profitFactor>1?'#34d399':'#f87171'],
                  ['Max drawdown',`${btResult.maxDrawdown}%`,btResult.maxDrawdown<15?'#34d399':'#f87171'],
                  ['Final equity',`$${btResult.finalEquity}`,btResult.finalEquity>10000?'#34d399':'#f87171'],
                  ['W/L',`${btResult.wins}/${btResult.losses}`,'#94a3b8'],
                ].map(([l,v,c])=>(
                  <div key={l} style={{ background:'rgba(255,255,255,0.02)', borderRadius:6, padding:'6px 8px',
                    border:'1px solid rgba(255,255,255,0.03)' }}>
                    <div style={{ fontSize:9, color:'#475569' }}>{l}</div>
                    <div style={{ fontSize:13, fontWeight:800, color:c }}>{v}</div>
                  </div>
                ))}
              </div>
              {btResult.equityCurve.length>2&&(
                <div style={{ height:50, background:'rgba(0,0,0,0.15)', borderRadius:5, overflow:'hidden' }}>
                  <svg width="100%" height="100%" viewBox={`0 0 ${btResult.equityCurve.length} 50`} preserveAspectRatio="none">
                    <polyline fill="none" stroke={btResult.finalEquity>10000?'#34d399':'#f87171'} strokeWidth="1.5"
                      points={btResult.equityCurve.map((v,i)=>{
                        const mn=Math.min(...btResult.equityCurve),mx=Math.max(...btResult.equityCurve);
                        return `${i},${50-((v-mn)/((mx-mn)||1))*46-2}`;
                      }).join(' ')}/>
                  </svg>
                </div>
              )}
            </div>
          )}
        </>)}

        {/* Log */}
        <div style={{ maxHeight:95, overflowY:'auto', display:'flex', flexDirection:'column', gap:2,
          background:'rgba(0,0,0,0.18)', borderRadius:6, padding:'4px 8px', border:'1px solid rgba(255,255,255,0.03)' }}>
          {botLog.length===0&&<div style={{ color:'#334155',fontSize:10 }}>Press Start.</div>}
          {botLog.map((l,i)=>(
            <div key={i} style={{ display:'flex', gap:7, fontSize:10, lineHeight:1.5 }}>
              <span style={{ color:'#1e3a5f', flexShrink:0 }}>{l.ts}</span>
              <span style={{ color:l.type==='success'?'#34d399':l.type==='danger'?'#f87171':
                l.type==='warn'?'#fbbf24':l.type==='muted'?'#2d4a5e':'#7f9fb5',wordBreak:'break-word' }}>{l.msg}</span>
            </div>
          ))}
        </div>

        <div style={{ fontSize:9, color:'#1e3a5f', lineHeight:1.6 }}>
          3 setups: Proven High Rejection · Compression Breakdown · Bottom Recovery. All require proven level + macro + behaviour.
        </div>
      </div>
    </div>
  );
});

/*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Integration — same as all previous versions.
  Just replace the file.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*/
