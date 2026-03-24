// TradingBot.jsx — Institutional Level Bot with Dynamic Role Reversal
// Levels are NOT permanently support or resistance.
// Their role is determined purely by where current price sits relative to them.

import {
  useEffect, useRef, useState, useCallback, useMemo,
  forwardRef, useImperativeHandle
} from 'react';

// ═══════════════════════════════════════════════════════════════════
//  MATH
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

function calcBBWidth(closes, period = 20) {
  if (!closes || closes.length < period) return null;
  const sl = closes.slice(-period);
  const mean = sl.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return (4 * std) / (mean || 1);
}

// ── Swing pivots ──────────────────────────────────────────────────
function findSwingPoints(candles, lookback = 5) {
  const points = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isH = true, isL = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isH = false;
      if (candles[j].l <= c.l) isL = false;
    }
    // Store both highs and lows as NEUTRAL price points — no label yet
    if (isH) points.push({ price: c.h, idx: i, origin: 'high' });
    if (isL) points.push({ price: c.l, idx: i, origin: 'low' });
  }
  return points;
}

// Cluster nearby points into zones regardless of high/low origin
function clusterLevels(points, pct = 0.0025) {
  const zones = [];
  const used = new Set();
  const sorted = [...points].sort((a, b) => a.price - b.price);
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const cluster = [sorted[i].price];
    const idxs = [sorted[i].idx];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(sorted[j].price - sorted[i].price) / sorted[i].price < pct) {
        cluster.push(sorted[j].price);
        idxs.push(sorted[j].idx);
        used.add(j);
      }
    }
    used.add(i);
    const avgPrice  = cluster.reduce((a, b) => a + b, 0) / cluster.length;
    const lastTouch = Math.max(...idxs);
    zones.push({
      price:     avgPrice,
      strength:  cluster.length,  // more touches = stronger level
      lastTouch,
      // role is NOT set here — it is determined dynamically from price
    });
  }
  return zones.sort((a, b) => b.strength - a.strength);
}

// ── THE KEY FUNCTION ──────────────────────────────────────────────
// Classify all levels dynamically based on current price.
// Above price = support. Below price... wait — flip it:
//   price ABOVE zone → zone acts as SUPPORT (floor)
//   price BELOW zone → zone acts as RESISTANCE (ceiling)
// Also detects role reversal: was this zone recently on the other side?
function classifyLevels(zones, currentPrice, atr) {
  const buffer = atr ? atr * 0.2 : currentPrice * 0.001;
  const supports = [];
  const resistances = [];

  for (const z of zones) {
    if (currentPrice > z.price + buffer) {
      // Price is above this level → it's acting as SUPPORT
      supports.push({ ...z, role: 'support', distPct: (currentPrice - z.price) / currentPrice * 100 });
    } else if (currentPrice < z.price - buffer) {
      // Price is below this level → it's acting as RESISTANCE
      resistances.push({ ...z, role: 'resistance', distPct: (z.price - currentPrice) / currentPrice * 100 });
    }
    // Levels within the buffer are "at price" — handled as near-level alerts
  }

  // Sort: supports descending (nearest first), resistances ascending (nearest first)
  supports.sort((a, b) => b.price - a.price);
  resistances.sort((a, b) => a.price - b.price);

  return { supports, resistances };
}

// Levels the price is currently testing (within touch zone)
function getLevelsAtPrice(zones, currentPrice, atr) {
  const touchZone = atr ? atr * 0.5 : currentPrice * 0.002;
  return zones.filter(z => Math.abs(z.price - currentPrice) <= touchZone);
}

// ── Trend ─────────────────────────────────────────────────────────
function getTrend(candles, markPrice) {
  const closes = candles.map(c => c.c);
  const ema21  = calcEMA(closes, 21);
  const ema50  = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  if (!ema21 || !ema50) return { dir: 'NEUTRAL', ema21, ema50, ema200, strength: 0 };
  let score = 0;
  if (markPrice > ema21)  score++;
  if (markPrice > ema50)  score++;
  if (ema21 > ema50)      score++;
  if (!ema200 || markPrice > ema200) score++;
  const dir = score >= 3 ? 'UP' : score <= 1 ? 'DOWN' : 'NEUTRAL';
  return { dir, ema21, ema50, ema200, strength: score };
}

// ── Candle pattern ────────────────────────────────────────────────
function detectPattern(candles) {
  if (!candles || candles.length < 3) return null;
  const c = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const range     = (c.h - c.l) || 0.001;
  const body      = Math.abs(c.c - c.o);
  const upperWick = c.h - Math.max(c.c, c.o);
  const lowerWick = Math.min(c.c, c.o) - c.l;

  if (upperWick / range > 0.55 && body / range < 0.35 && c.c < prev.c)
    return { type: 'BEARISH_PIN', label: 'Bearish pin', dir: 'bear', conf: Math.round(upperWick / range * 100) };
  if (lowerWick / range > 0.55 && body / range < 0.35 && c.c > prev.c)
    return { type: 'BULLISH_PIN', label: 'Bullish pin', dir: 'bull', conf: Math.round(lowerWick / range * 100) };
  if (prev.c > prev.o && c.c < c.o && c.o >= prev.c && c.c <= prev.o)
    return { type: 'BEARISH_ENG', label: 'Bearish engulf', dir: 'bear', conf: 80 };
  if (prev.c < prev.o && c.c > c.o && c.o <= prev.c && c.c >= prev.o)
    return { type: 'BULLISH_ENG', label: 'Bullish engulf', dir: 'bull', conf: 80 };

  const last3    = candles.slice(-3);
  const avgBody  = last3.reduce((s, x) => s + Math.abs(x.c - x.o), 0) / 3;
  const avgRange = last3.reduce((s, x) => s + (x.h - x.l), 0) / 3;
  const prevAvgRange = candles.length > 8
    ? candles.slice(-8, -3).reduce((s, x) => s + (x.h - x.l), 0) / 5
    : avgRange * 2;
  if (avgBody / (avgRange || 1) < 0.35 && avgRange < prevAvgRange * 0.55)
    return { type: 'COMPRESSION', label: 'Compression', dir: 'neutral', conf: 65 };

  return null;
}

// ── Level-based TP/SL ─────────────────────────────────────────────
// Uses the dynamically classified levels — not ATR
function getLevelTargets({ markPrice, side, supports, resistances, atr, minRR = 1.5 }) {
  let tp = null, sl = null, tpLevel = null, slLevel = null;

  if (side === 'buy') {
    // TP = nearest resistance above (where price will travel to)
    tpLevel = resistances[0] || null;
    tp      = tpLevel?.price || null;
    // SL = just below nearest support below (level that invalidates)
    slLevel = supports[0] || null;
    const slBase = slLevel ? slLevel.price : markPrice - (atr || markPrice * 0.005) * 2;
    sl = slBase - (atr ? atr * 0.25 : markPrice * 0.001);
  } else {
    // TP = nearest support below
    tpLevel = supports[0] || null;
    tp      = tpLevel?.price || null;
    // SL = just above nearest resistance above
    slLevel = resistances[0] || null;
    const slBase = slLevel ? slLevel.price : markPrice + (atr || markPrice * 0.005) * 2;
    sl = slBase + (atr ? atr * 0.25 : markPrice * 0.001);
  }

  if (!tp || !sl) return { tp, sl, rr: null, tpLevel, slLevel, valid: false };

  const reward = side === 'buy' ? tp - markPrice : markPrice - tp;
  const risk   = side === 'buy' ? markPrice - sl : sl - markPrice;
  const rr     = risk > 0 ? +(reward / risk).toFixed(2) : null;
  const valid  = rr !== null && rr >= minRR;

  return { tp, sl, rr, tpLevel, slLevel, valid };
}

// ═══════════════════════════════════════════════════════════════════
//  STRATEGIES
// ═══════════════════════════════════════════════════════════════════

const STRATEGIES = {

  LEVEL_BOUNCE: {
    name: 'Level Bounce', tag: 'LB',
    desc: 'Bounce from a level when trend agrees. TP/SL = next levels above/below.',
    minRR: 1.5,
    evaluate({ candles, markPrice, supports, resistances, atLevel, atr, trend, pattern, rsiVal }) {
      // LONG: Price at a level that's currently acting as support + bullish confirmation + uptrend
      if (trend.dir === 'UP' || trend.dir === 'NEUTRAL') {
        for (const z of atLevel) {
          // This level is currently being tested as support (price came from above)
          const isSupport = z.price < markPrice || Math.abs(z.price - markPrice) / markPrice < 0.002;
          if (!isSupport) continue;
          const bull = pattern?.dir === 'bull';
          const rsiOk = rsiVal < 60;
          if (!bull) continue;
          const score = z.strength * 20 + pattern.conf * 0.4 + (rsiOk ? 18 : 0) + trend.strength * 8;
          const targets = getLevelTargets({ markPrice, side: 'buy', supports, resistances, atr, minRR: this.minRR });
          if (!targets.valid) return { signal: 'HOLD', score: 0, reason: `Bounce at $${z.price.toFixed(0)} · R:R ${targets.rr ?? '—'} < ${this.minRR}` };
          return { signal: 'BUY', score: Math.round(score), ...targets,
            reason: `Support bounce @ $${z.price.toFixed(0)} (str×${z.strength}) · ${pattern.label} · RSI ${rsiVal.toFixed(1)}` };
        }
      }

      // SHORT: Price at a level acting as resistance + bearish confirmation + downtrend
      if (trend.dir === 'DOWN' || trend.dir === 'NEUTRAL') {
        for (const z of atLevel) {
          const isResist = z.price > markPrice || Math.abs(z.price - markPrice) / markPrice < 0.002;
          if (!isResist) continue;
          const bear = pattern?.dir === 'bear';
          const rsiOk = rsiVal > 45;
          if (!bear) continue;
          const score = z.strength * 20 + pattern.conf * 0.4 + (rsiOk ? 18 : 0) + trend.strength * 8;
          const targets = getLevelTargets({ markPrice, side: 'sell', supports, resistances, atr, minRR: this.minRR });
          if (!targets.valid) return { signal: 'HOLD', score: 0, reason: `Rejection at $${z.price.toFixed(0)} · R:R ${targets.rr ?? '—'} < ${this.minRR}` };
          return { signal: 'SELL', score: Math.round(score), ...targets,
            reason: `Resistance rejection @ $${z.price.toFixed(0)} (str×${z.strength}) · ${pattern.label} · RSI ${rsiVal.toFixed(1)}` };
        }
      }

      return { signal: 'HOLD', score: 0, reason: `Not at a key level · Nearest sup $${supports[0]?.price.toFixed(0) ?? '—'} · res $${resistances[0]?.price.toFixed(0) ?? '—'}` };
    }
  },

  COIL_BREAK: {
    name: 'Coil & Break', tag: 'CB',
    desc: 'Compression at a level → trades the breakout. TP/SL = next levels.',
    minRR: 1.5,
    evaluate({ candles, markPrice, supports, resistances, atLevel, atr, trend, pattern, rsiVal }) {
      const closes   = candles.map(c => c.c);
      const bbW      = calcBBWidth(closes);
      const isComp   = pattern?.type === 'COMPRESSION';
      const recentBW = [];
      for (let i = 25; i <= Math.min(closes.length, 80); i++) recentBW.push(calcBBWidth(closes.slice(0, i)) ?? 0);
      recentBW.sort((a, b) => a - b);
      const medBW  = recentBW[Math.floor(recentBW.length * 0.5)] || 0.01;
      const squeeze = bbW !== null && bbW < medBW * 0.72;

      if (!isComp && !squeeze) return { signal: 'HOLD', score: 0, reason: `No compression · BBW ${bbW?.toFixed(4) ?? '—'}` };
      if (!atLevel.length)     return { signal: 'HOLD', score: 0, reason: `Compression but not at a key level` };

      const base = 45 + (isComp ? 20 : 0) + (squeeze ? 18 : 0);

      // Compression at any level → direction determined by trend
      for (const z of atLevel) {
        if (trend.dir === 'DOWN' || trend.dir === 'NEUTRAL') {
          const score = base + z.strength * 12 + (trend.dir === 'DOWN' ? 18 : 0);
          const targets = getLevelTargets({ markPrice, side: 'sell', supports, resistances, atr, minRR: this.minRR });
          if (!targets.valid) continue;
          return { signal: 'SELL', score, ...targets,
            reason: `Coil at $${z.price.toFixed(0)} · Squeeze · Drop expected · Trend ${trend.dir}` };
        }
        if (trend.dir === 'UP' || trend.dir === 'NEUTRAL') {
          const score = base + z.strength * 12 + (trend.dir === 'UP' ? 18 : 0);
          const targets = getLevelTargets({ markPrice, side: 'buy', supports, resistances, atr, minRR: this.minRR });
          if (!targets.valid) continue;
          return { signal: 'BUY', score, ...targets,
            reason: `Coil at $${z.price.toFixed(0)} · Squeeze · Spring expected · Trend ${trend.dir}` };
        }
      }
      return { signal: 'HOLD', score: 0, reason: `Compression at level · Waiting for trend clarity` };
    }
  },

  TREND_PULLBACK: {
    name: 'Trend Pullback', tag: 'TP',
    desc: 'Strong trend → pullback to nearest level → continuation entry. TP = previous swing.',
    minRR: 1.8,
    evaluate({ candles, markPrice, supports, resistances, atLevel, atr, trend, pattern, rsiVal }) {
      if (trend.strength < 3) return { signal: 'HOLD', score: 0, reason: `Trend str ${trend.strength}/4 — need ≥3 for continuation` };

      if (trend.dir === 'UP') {
        // Pullback to support, RSI cooled, bullish pattern
        for (const z of atLevel) {
          const rsiOk = rsiVal < 52;
          const bull  = pattern?.dir === 'bull';
          const score = 50 + trend.strength * 12 + z.strength * 12 + (rsiOk ? 15 : 0) + (bull ? 15 : 0);
          const targets = getLevelTargets({ markPrice, side: 'buy', supports, resistances, atr, minRR: this.minRR });
          if (!targets.valid) return { signal: 'HOLD', score: 0, reason: `Pullback to $${z.price.toFixed(0)} · R:R ${targets.rr ?? '—'} < ${this.minRR}` };
          return { signal: 'BUY', score, ...targets,
            reason: `Uptrend pullback to $${z.price.toFixed(0)} · RSI ${rsiVal.toFixed(1)} · Trend str ${trend.strength}/4` };
        }
        return { signal: 'HOLD', score: 0, reason: `Strong uptrend · Waiting for pullback to a level` };
      }

      if (trend.dir === 'DOWN') {
        for (const z of atLevel) {
          const rsiOk = rsiVal > 52;
          const bear  = pattern?.dir === 'bear';
          const score = 50 + trend.strength * 12 + z.strength * 12 + (rsiOk ? 15 : 0) + (bear ? 15 : 0);
          const targets = getLevelTargets({ markPrice, side: 'sell', supports, resistances, atr, minRR: this.minRR });
          if (!targets.valid) return { signal: 'HOLD', score: 0, reason: `Bounce to $${z.price.toFixed(0)} · R:R ${targets.rr ?? '—'} < ${this.minRR}` };
          return { signal: 'SELL', score, ...targets,
            reason: `Downtrend bounce to $${z.price.toFixed(0)} · RSI ${rsiVal.toFixed(1)} · Trend str ${trend.strength}/4` };
        }
        return { signal: 'HOLD', score: 0, reason: `Strong downtrend · Waiting for bounce to a level` };
      }

      return { signal: 'HOLD', score: 0, reason: `Trend NEUTRAL` };
    }
  },

  COMPOSITE: {
    name: 'Composite ★', tag: 'ALL',
    desc: 'Runs all strategies. Best score wins. Levels always dynamic.',
    evaluate(ctx) {
      const results = [
        { key: 'LB', ...STRATEGIES.LEVEL_BOUNCE.evaluate(ctx) },
        { key: 'CB', ...STRATEGIES.COIL_BREAK.evaluate(ctx) },
        { key: 'TP', ...STRATEGIES.TREND_PULLBACK.evaluate(ctx) },
      ];
      const active = results.filter(r => r.signal !== 'HOLD').sort((a, b) => b.score - a.score);
      if (!active.length) return { signal: 'HOLD', score: 0, reason: results.map(r => `[${r.key}] ${r.reason}`).join(' · ') };
      const best = active[0];
      return { ...best, reason: `[${best.key}] ${best.reason}` };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════
//  HOOK
// ═══════════════════════════════════════════════════════════════════

export function useTradingBot({ candles, markPrice, openPosition, closePosition, positions, log }) {
  const [running, setRunning]           = useState(false);
  const [activeStrat, setActiveStrat]   = useState('COMPOSITE');
  const [signal, setSignal]             = useState('HOLD');
  const [lastEval, setLastEval]         = useState(null);
  const [stats, setStats]               = useState({ trades: 0, wins: 0, losses: 0, totalPnl: 0 });
  const [botLog, setBotLog]             = useState([]);
  // All levels as a unified pool — role assigned dynamically
  const [allZones, setAllZones]         = useState([]);
  const [classified, setClassified]     = useState({ supports: [], resistances: [], atLevel: [] });

  const botPosIdRef   = useRef(null);
  const activeTpRef   = useRef(null);
  const activeSlRef   = useRef(null);
  const activeSideRef = useRef(null);
  const intervalRef   = useRef(null);

  const addLog = useCallback((msg, type = 'info') => {
    const ts = new Date().toLocaleTimeString();
    setBotLog(l => [{ ts, msg, type }, ...l].slice(0, 100));
    if (log) log(`[BOT] ${msg}`, type);
  }, [log]);

  // Rebuild zone pool when candles change
  useEffect(() => {
    if (!candles || candles.length < 30) return;
    const points = findSwingPoints(candles.slice(-200), 4);
    const zones  = clusterLevels(points);
    setAllZones(zones);
  }, [candles]);

  // Re-classify zones whenever price or zones change — THIS is the dynamic role reversal
  useEffect(() => {
    if (!allZones.length || !markPrice) return;
    const atr = calcATR(candles);
    const { supports, resistances } = classifyLevels(allZones, markPrice, atr);
    const atLevel = getLevelsAtPrice(allZones, markPrice, atr);
    setClassified({ supports, resistances, atLevel });
  }, [allZones, markPrice, candles]);

  const tick = useCallback(() => {
    if (!candles || candles.length < 60 || !markPrice) return;

    const closes  = candles.map(c => c.c);
    const atr     = calcATR(candles);
    const trend   = getTrend(candles, markPrice);
    const pattern = detectPattern(candles);
    const rsiVal  = calcRSI(closes);
    const { supports, resistances, atLevel } = classified;

    const strat  = STRATEGIES[activeStrat];
    const result = strat.evaluate({ candles, markPrice, supports, resistances, atLevel, atr, trend, pattern, rsiVal });
    setSignal(result.signal);
    setLastEval(result);

    const hasOpenPos = botPosIdRef.current !== null && positions.some(p => p.id === botPosIdRef.current);

    // ── Manage open position ──────────────────────────────────
    if (hasOpenPos && activeTpRef.current && activeSlRef.current) {
      const pos  = positions.find(p => p.id === botPosIdRef.current);
      if (pos) {
        const side  = activeSideRef.current;
        const hitTP = side === 'buy' ? markPrice >= activeTpRef.current : markPrice <= activeTpRef.current;
        const hitSL = side === 'buy' ? markPrice <= activeSlRef.current : markPrice >= activeSlRef.current;

        // Level invalidation: if a support the trade depends on has now become resistance
        // (i.e. price broke below it), exit early
        const invalidated = side === 'buy'
          ? resistances.some(z => z.price > pos.entry * 0.999 && z.price < pos.entry * 1.001 && markPrice < z.price)
          : supports.some(z => z.price > pos.entry * 0.999 && z.price < pos.entry * 1.001 && markPrice > z.price);

        if (hitTP || hitSL || invalidated) {
          const pnl = side === 'buy'
            ? pos.qty * (markPrice - pos.entry)
            : pos.qty * (pos.entry - markPrice);
          closePosition(botPosIdRef.current);
          setStats(s => ({ ...s, trades: s.trades + 1,
            wins: pnl > 0 ? s.wins + 1 : s.wins,
            losses: pnl <= 0 ? s.losses + 1 : s.losses,
            totalPnl: s.totalPnl + pnl }));
          const why = hitTP ? 'TP — next level hit' : invalidated ? 'Level role reversed — invalidated' : 'SL — level broken';
          addLog(`EXIT · ${why} · PnL ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, pnl > 0 ? 'success' : 'danger');
          botPosIdRef.current = null; activeTpRef.current = null;
          activeSlRef.current = null; activeSideRef.current = null;
          return;
        }
      }
    }

    // ── Enter ──────────────────────────────────────────────────
    if (!hasOpenPos && result.signal !== 'HOLD' && result.tp && result.sl) {
      const side = result.signal === 'BUY' ? 'buy' : 'sell';
      openPosition(side, null);
      botPosIdRef.current   = Date.now();
      activeTpRef.current   = result.tp;
      activeSlRef.current   = result.sl;
      activeSideRef.current = side;
      addLog(`${result.signal} · Score ${result.score} · R:R ${result.rr} · ${result.reason}`, side === 'buy' ? 'success' : 'warn');
      addLog(`  TP $${result.tp.toFixed(1)} · SL $${result.sl.toFixed(1)}`, 'muted');
    }
  }, [candles, markPrice, openPosition, closePosition, positions, activeStrat, classified, addLog]);

  useEffect(() => {
    if (running) { intervalRef.current = setInterval(tick, 4000); }
    else { clearInterval(intervalRef.current); }
    return () => clearInterval(intervalRef.current);
  }, [running, tick]);

  const start = useCallback((strat) => {
    if (strat) setActiveStrat(strat);
    setRunning(true);
    addLog(`Started · ${STRATEGIES[strat || activeStrat].name} · Dynamic level roles`, 'success');
  }, [activeStrat, addLog]);

  const stop  = useCallback(() => { setRunning(false); addLog('Stopped', 'warn'); }, [addLog]);
  const reset = useCallback(() => {
    setRunning(false);
    setStats({ trades: 0, wins: 0, losses: 0, totalPnl: 0 });
    setBotLog([]);
    botPosIdRef.current = null; activeTpRef.current = null;
    activeSlRef.current = null; activeSideRef.current = null;
    addLog('Reset', 'muted');
  }, [addLog]);

  const winRate = (stats.wins + stats.losses) > 0
    ? Math.round(stats.wins / (stats.wins + stats.losses) * 100) : null;

  return { running, signal, lastEval, stats, botLog, winRate,
           allZones, classified, activeStrat, setActiveStrat, start, stop, reset };
}

// ═══════════════════════════════════════════════════════════════════
//  PANEL UI
// ═══════════════════════════════════════════════════════════════════

const SIG_COLOR  = { BUY:'#00ffe1', SELL:'#ff7ab0', HOLD:'#94a3b8' };
const SIG_BG     = { BUY:'rgba(0,255,209,0.07)', SELL:'rgba(255,92,158,0.07)', HOLD:'rgba(148,163,184,0.04)' };
const SIG_BORDER = { BUY:'rgba(0,255,209,0.2)', SELL:'rgba(255,92,158,0.2)', HOLD:'rgba(148,163,184,0.08)' };

export const BotPanel = forwardRef(function BotPanel(
  { candles, markPrice, openPosition, closePosition, positions, log }, ref
) {
  const bot = useTradingBot({ candles, markPrice, openPosition, closePosition, positions, log });
  const { running, signal, lastEval, stats, botLog, winRate,
          allZones, classified, activeStrat, setActiveStrat, start, stop, reset } = bot;

  useImperativeHandle(ref, () => ({ start, stop, reset }), [start, stop, reset]);

  const [showLevels, setShowLevels] = useState(false);

  const closes = useMemo(() => (candles || []).map(c => c.c).filter(Boolean), [candles]);
  const atr    = useMemo(() => calcATR(candles), [candles]);
  const rsiVal = useMemo(() => calcRSI(closes), [closes]);
  const trend  = useMemo(() => candles?.length >= 22 ? getTrend(candles, markPrice) : null, [candles, markPrice]);
  const trendCol = d => d === 'UP' ? '#34d399' : d === 'DOWN' ? '#f87171' : '#94a3b8';
  const scoreCol = s => s >= 80 ? '#00ffe1' : s >= 55 ? '#fbbf24' : '#94a3b8';

  const { supports, resistances, atLevel } = classified;

  return (
    <div style={{ display:'flex', flexDirection:'column' }}>
      <div className="phdr" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span>Auto Bot</span>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:9, color: running ? '#34d399':'#475569', letterSpacing:'.1em' }}>{running?'RUNNING':'IDLE'}</span>
          <div style={{ width:6, height:6, borderRadius:'50%', background: running?'#34d399':'#475569',
            boxShadow: running?'0 0 5px #34d399':'none', animation: running?'pulse 1.8s infinite':'none' }} />
        </div>
      </div>

      <div style={{ padding:'8px 10px', display:'flex', flexDirection:'column', gap:8 }}>

        {/* Strategy selector */}
        <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
          <div style={{ fontSize:10, color:'#475569', marginBottom:1 }}>Strategy</div>
          {Object.entries(STRATEGIES).map(([key, s]) => (
            <button key={key} className={`btn ${activeStrat===key?'btn-on':''}`}
              style={{ textAlign:'left', padding:'5px 9px', fontSize:11, width:'100%', borderRadius:7 }}
              onClick={() => { setActiveStrat(key); if (running) { stop(); setTimeout(() => start(key), 80); } }}>
              <span style={{ fontWeight:700 }}>[{s.tag}] {s.name}</span>
              <div style={{ fontSize:9, color: activeStrat===key?'#7acfff':'#334155', marginTop:2 }}>{s.desc}</div>
            </button>
          ))}
        </div>

        {/* Signal + Trend */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
          <div style={{ background:SIG_BG[signal], border:`1px solid ${SIG_BORDER[signal]}`, borderRadius:8, padding:'7px 10px' }}>
            <div style={{ fontSize:9, color:'#475569' }}>Signal</div>
            <div style={{ fontWeight:800, fontSize:17, color:SIG_COLOR[signal] }}>{signal}</div>
            {lastEval?.score > 0 && <div style={{ fontSize:10, color:scoreCol(lastEval.score) }}>Score {lastEval.score}</div>}
          </div>
          <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.04)', borderRadius:8, padding:'7px 10px' }}>
            <div style={{ fontSize:9, color:'#475569' }}>Trend</div>
            <div style={{ fontWeight:800, fontSize:17, color:trendCol(trend?.dir) }}>{trend?.dir ?? '—'}</div>
            <div style={{ fontSize:10, color:'#475569' }}>str {trend?.strength ?? '—'}/4</div>
          </div>
        </div>

        {/* At-level alert — shows all levels currently being tested */}
        {atLevel.length > 0 && (
          <div style={{ padding:'6px 10px', borderRadius:7, fontSize:11, fontWeight:700,
            background:'rgba(251,191,36,0.07)', border:'1px solid rgba(251,191,36,0.2)', color:'#fbbf24' }}>
            TESTING LEVEL{atLevel.length > 1 ? 'S' : ''}: {atLevel.map(z => `$${z.price.toFixed(0)} ×${z.strength}`).join(' · ')}
            <div style={{ fontSize:9, fontWeight:400, color:'#856c1a', marginTop:2 }}>
              Role = {markPrice > atLevel[0].price ? 'SUPPORT (breakout retest)' : 'RESISTANCE (rejection zone)'}
            </div>
          </div>
        )}

        {/* Reason */}
        {lastEval?.reason && (
          <div style={{ fontSize:10, color:'#5b7e93', background:'rgba(0,0,0,0.18)', padding:'5px 8px', borderRadius:5, lineHeight:1.7 }}>
            {lastEval.reason}
          </div>
        )}

        {/* TP / SL / R:R */}
        {lastEval?.tp && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:5 }}>
            <div style={{ background:'rgba(0,255,209,0.04)', border:'1px solid rgba(0,255,209,0.1)', borderRadius:6, padding:'5px 7px', textAlign:'center' }}>
              <div style={{ fontSize:9, color:'#475569' }}>TP (next lvl)</div>
              <div style={{ fontSize:11, fontWeight:700, color:'#34d399' }}>${lastEval.tp.toFixed(0)}</div>
            </div>
            <div style={{ background:'rgba(248,113,113,0.04)', border:'1px solid rgba(248,113,113,0.1)', borderRadius:6, padding:'5px 7px', textAlign:'center' }}>
              <div style={{ fontSize:9, color:'#475569' }}>SL (invalidate)</div>
              <div style={{ fontSize:11, fontWeight:700, color:'#f87171' }}>${lastEval.sl?.toFixed(0)}</div>
            </div>
            <div style={{ background:'rgba(251,191,36,0.04)', border:'1px solid rgba(251,191,36,0.1)', borderRadius:6, padding:'5px 7px', textAlign:'center' }}>
              <div style={{ fontSize:9, color:'#475569' }}>R:R</div>
              <div style={{ fontSize:11, fontWeight:700, color: lastEval.rr >= 2?'#34d399':lastEval.rr >= 1.5?'#fbbf24':'#f87171' }}>
                {lastEval.rr ?? '—'}
              </div>
            </div>
          </div>
        )}

        {/* Indicators */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:4 }}>
          {[
            ['RSI', rsiVal?rsiVal.toFixed(1):'—', rsiVal>70?'#f87171':rsiVal<35?'#34d399':'#94a3b8'],
            ['ATR', atr?`$${atr.toFixed(0)}`:'—', '#9ddfff'],
            ['EMA21', trend?.ema21?trend.ema21.toFixed(0):'—', trendCol(trend?.dir)],
          ].map(([l,v,c]) => (
            <div key={l} style={{ background:'rgba(255,255,255,0.02)', borderRadius:6, padding:'5px 6px', textAlign:'center', border:'1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ fontSize:9, color:'#475569' }}>{l}</div>
              <div style={{ fontSize:12, fontWeight:700, color:c }}>{v}</div>
            </div>
          ))}
        </div>

        {/* Stats */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:4 }}>
          {[
            ['Trades', stats.trades, '#9ddfff'],
            ['Wins',   stats.wins,   '#34d399'],
            ['Loss',   stats.losses, '#f87171'],
            ['Win%', winRate!=null?`${winRate}%`:'—', winRate!=null?(winRate>=50?'#34d399':'#f87171'):'#94a3b8'],
          ].map(([l,v,c]) => (
            <div key={l} style={{ background:'rgba(255,255,255,0.02)', borderRadius:6, padding:'5px 5px', textAlign:'center', border:'1px solid rgba(255,255,255,0.03)' }}>
              <div style={{ fontSize:9, color:'#475569', marginBottom:1 }}>{l}</div>
              <div style={{ fontSize:13, fontWeight:800, color:c }}>{v}</div>
            </div>
          ))}
        </div>

        {/* PnL */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span style={{ fontSize:11, color:'#94a3b8' }}>Total PnL</span>
          <span style={{ fontWeight:800, fontSize:15, color:stats.totalPnl>=0?'#00ffe1':'#ff7ab0' }}>
            {stats.totalPnl>=0?'+':''}${stats.totalPnl.toFixed(2)}
          </span>
        </div>

        {/* Controls */}
        <div style={{ display:'flex', gap:6 }}>
          {!running
            ? <button className="btn btn-green" style={{ flex:1, fontSize:11 }} onClick={() => start()}>▶ Start</button>
            : <button className="btn btn-red"   style={{ flex:1, fontSize:11 }} onClick={stop}>■ Stop</button>}
          <button className="btn" style={{ fontSize:11 }} onClick={reset}>Reset</button>
          <button className={`btn ${showLevels?'btn-on':''}`} style={{ fontSize:11 }} onClick={() => setShowLevels(l=>!l)}>
            Levels ({allZones.length})
          </button>
        </div>

        {/* Dynamic levels panel */}
        {showLevels && (
          <div style={{ background:'rgba(0,0,0,0.22)', borderRadius:7, padding:'8px 10px', border:'1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:6, letterSpacing:'.1em' }}>
              ALL LEVELS — role assigned dynamically from current price ${markPrice?.toFixed(0)}
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              {[
                ['↑ RESISTANCE (above price)', resistances, '#f87171'],
                ['↓ SUPPORT (below price)',    supports,    '#34d399'],
              ].map(([title, zones, col]) => (
                <div key={title}>
                  <div style={{ fontSize:9, color:col, marginBottom:4 }}>{title}</div>
                  {zones.slice(0, 6).map((z, i) => (
                    <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:11,
                      padding:'3px 0', borderBottom:'1px solid rgba(255,255,255,0.025)',
                      color: i === 0 ? col : '#7f9fb5', fontWeight: i === 0 ? 700 : 400 }}>
                      <span>${z.price.toFixed(1)}</span>
                      <span style={{ fontSize:9, color:'#334155' }}>×{z.strength} {z.distPct < 0.5 ? '⚡' : ''}</span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
            {atLevel.length > 0 && (
              <div style={{ marginTop:8, padding:'5px 8px', borderRadius:5,
                background:'rgba(251,191,36,0.06)', border:'1px solid rgba(251,191,36,0.15)',
                fontSize:10, color:'#fbbf24' }}>
                AT LEVEL NOW: {atLevel.map(z => `$${z.price.toFixed(0)}`).join(', ')} — role determined by price action
              </div>
            )}
            <div style={{ marginTop:6, fontSize:9, color:'#1e3a5f', lineHeight:1.6 }}>
              Levels have no fixed label. Old resistance becomes support once price breaks above it. ×N = pivot touches.
            </div>
          </div>
        )}

        {/* Log */}
        <div style={{ maxHeight:110, overflowY:'auto', display:'flex', flexDirection:'column', gap:2,
          background:'rgba(0,0,0,0.18)', borderRadius:6, padding:'5px 8px', border:'1px solid rgba(255,255,255,0.03)' }}>
          {botLog.length === 0 && <div style={{ color:'#334155', fontSize:10 }}>Select strategy → Start.</div>}
          {botLog.map((l, i) => (
            <div key={i} style={{ display:'flex', gap:7, fontSize:10, lineHeight:1.55 }}>
              <span style={{ color:'#1e3a5f', flexShrink:0 }}>{l.ts}</span>
              <span style={{ color: l.type==='success'?'#34d399':l.type==='danger'?'#f87171':l.type==='warn'?'#fbbf24':l.type==='muted'?'#2d4a5e':'#7f9fb5', wordBreak:'break-word' }}>{l.msg}</span>
            </div>
          ))}
        </div>

        <div style={{ fontSize:9, color:'#1e3a5f', lineHeight:1.6 }}>
          Role reversal is live: resistance → support on breakout. TP/SL always set to real levels, never ATR multiples.
        </div>
      </div>
    </div>
  );
});

/*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  INTEGRATION — no changes from v2 needed.
  Just replace the file. ref={botRef} stays.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*/
