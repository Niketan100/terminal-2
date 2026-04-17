// useStructure.js — Market structure engine for 5m chart
// Exports: useLargeOrders, useMarketStructure
// All logic is pure — no side effects, memoizable

// ─── Large Order Detection ────────────────────────────────────────
// Top 1% of trade sizes seen. Accumulates a rolling window of sizes,
// computes the 99th percentile, marks any trade above it.

export function detectLargeOrders(trades, candles, percentile = 99) {
  if (!trades || trades.length < 10 || !candles || !candles.length) return [];

  const sizes = trades.map(t => parseFloat(t.size) || 0).filter(s => s > 0).sort((a, b) => a - b);
  if (!sizes.length) return [];

  const idx       = Math.floor((percentile / 100) * sizes.length);
  const threshold = sizes[Math.min(idx, sizes.length - 1)];
  if (threshold <= 0) return [];

  // Match each large trade to the nearest candle by timestamp
  const large = trades.filter(t => (parseFloat(t.size) || 0) >= threshold);

  // For each large trade, find which candle index it belongs to
  // useDeltaWS candles have .t (ISO string). Trades have .tms (epoch ms)
  const result = [];
  for (const t of large) {
    const price = parseFloat(t.price) || 0;
    if (!price) continue;
    // Find nearest candle (binary search by time)
    let bestIdx = candles.length - 1;
    let bestDiff = Infinity;
    for (let i = 0; i < candles.length; i++) {
      const ct  = new Date(candles[i].t + (candles[i].t.endsWith('Z') ? '' : 'Z')).getTime();
      const diff = Math.abs(ct - t.tms);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
      else if (diff > bestDiff) break; // sorted, can exit early
    }
    result.push({
      candleIdx: bestIdx,
      price,
      size:  parseFloat(t.size),
      side:  t.side,
      tms:   t.tms,
      threshold,
    });
  }
  return result;
}

// ─── Market Structure Engine ──────────────────────────────────────
// Produces: swingHighs, swingLows, BOS events, CHoCH events, FVGs, session lines

export function analyzeStructure(candles, config = {}) {
  const {
    swingLookback = 3,   // candles each side to qualify a swing
    fvgMinAtr     = 0.3, // FVG gap must be > ATR × this
    sessionOffset = 5.5, // IST offset from UTC (India = UTC+5:30)
  } = config;

  if (!candles || candles.length < swingLookback * 2 + 2) return emptyStructure();

  const n   = candles.length;
  const atr = computeATR(candles, 14) || 1;

  // ── Step 1: Find swing highs and lows ──────────────────────────
  const swingHighs = [], swingLows = [];
  for (let i = swingLookback; i < n - swingLookback; i++) {
    const c = candles[i];
    let isH = true, isL = true;
    for (let j = i - swingLookback; j <= i + swingLookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isH = false;
      if (candles[j].l <= c.l) isL = false;
    }
    if (isH) swingHighs.push({ idx: i, price: c.h, t: c.t });
    if (isL) swingLows.push({ idx: i, price: c.l, t: c.t });
  }

  // ── Step 2: Determine current trend from structure ─────────────
  // Trend UP = HH + HL. Trend DOWN = LH + LL.
  let trend = 'NEUTRAL';
  if (swingHighs.length >= 2 && swingLows.length >= 2) {
    const lastH  = swingHighs[swingHighs.length - 1];
    const prevH  = swingHighs[swingHighs.length - 2];
    const lastL  = swingLows[swingLows.length - 1];
    const prevL  = swingLows[swingLows.length - 2];
    const hhOk   = lastH.price > prevH.price;
    const hlOk   = lastL.price > prevL.price;
    const llOk   = lastL.price < prevL.price;
    const lhOk   = lastH.price < prevH.price;
    if (hhOk && hlOk) trend = 'UP';
    else if (llOk && lhOk) trend = 'DOWN';
  }

  // ── Step 3: BOS and CHoCH events ──────────────────────────────
  // BOS  = price closes BEYOND the most recent swing high (in uptrend) or low (in downtrend)
  //        — confirms continuation
  // CHoCH = BOS in the OPPOSITE direction of current trend — first sign of reversal
  const bosEvents   = [];
  const chochEvents = [];

  // Walk candles forward, tracking last swing level broken
  let lastBrokenHigh = null, lastBrokenLow = null;
  let runningTrend = trend;

  for (let i = swingLookback + 1; i < n; i++) {
    const c = candles[i];

    // Check if this candle's close broke above any prior swing high
    for (const sh of swingHighs) {
      if (sh.idx >= i) continue; // only prior highs
      if (lastBrokenHigh && sh.idx <= lastBrokenHigh.idx) continue;
      if (c.c > sh.price) {
        const isCHoCH = runningTrend === 'DOWN';
        const event = {
          type:      isCHoCH ? 'CHoCH' : 'BOS',
          direction: 'UP',
          idx:       i,
          price:     sh.price,
          candleC:   c.c,
          t:         c.t,
          swingIdx:  sh.idx,
        };
        if (isCHoCH) { chochEvents.push(event); runningTrend = 'UP'; }
        else bosEvents.push(event);
        lastBrokenHigh = sh;
        break;
      }
    }

    // Check if this candle's close broke below any prior swing low
    for (const sl of swingLows) {
      if (sl.idx >= i) continue;
      if (lastBrokenLow && sl.idx <= lastBrokenLow.idx) continue;
      if (c.c < sl.price) {
        const isCHoCH = runningTrend === 'UP';
        const event = {
          type:      isCHoCH ? 'CHoCH' : 'BOS',
          direction: 'DOWN',
          idx:       i,
          price:     sl.price,
          candleC:   c.c,
          t:         c.t,
          swingIdx:  sl.idx,
        };
        if (isCHoCH) { chochEvents.push(event); runningTrend = 'DOWN'; }
        else bosEvents.push(event);
        lastBrokenLow = sl;
        break;
      }
    }
  }

  // ── Step 4: Fair Value Gaps ─────────────────────────────────────
  // FVG = 3-candle pattern where candle[i-2].high < candle[i].low (bull FVG)
  //                            or candle[i-2].low  > candle[i].high (bear FVG)
  const fvgs = [];
  const minGap = atr * fvgMinAtr;
  for (let i = 2; i < n; i++) {
    const c0 = candles[i - 2], c1 = candles[i - 1], c2 = candles[i];
    // Bullish FVG: gap between c0.high and c2.low (price jumped up, left gap)
    if (c2.l > c0.h && c2.l - c0.h > minGap) {
      fvgs.push({ type:'BULL', top: c2.l, bottom: c0.h, idx: i, filled: false, t: c2.t });
    }
    // Bearish FVG: gap between c0.low and c2.high (price fell, left gap above)
    if (c2.h < c0.l && c0.l - c2.h > minGap) {
      fvgs.push({ type:'BEAR', top: c0.l, bottom: c2.h, idx: i, filled: false, t: c2.t });
    }
  }

  // Mark FVGs as filled if price has since returned into them
  for (const fvg of fvgs) {
    for (let i = fvg.idx + 1; i < n; i++) {
      const c = candles[i];
      if (fvg.type === 'BULL' && c.l <= fvg.top   && c.h >= fvg.bottom) { fvg.filled = true; fvg.fillIdx = i; break; }
      if (fvg.type === 'BEAR' && c.h >= fvg.bottom && c.l <= fvg.top)   { fvg.filled = true; fvg.fillIdx = i; break; }
    }
  }

  // ── Step 5: Session open lines ─────────────────────────────────
  // Find the first candle of each session in the visible data
  // Asia: 05:30 IST (00:00 UTC), London: 13:30 IST (08:00 UTC), NY: 18:30 IST (13:00 UTC)
  const sessions = [];
  const seenSessions = new Set();
  for (let i = 0; i < n; i++) {
    const c   = candles[i];
    const dt  = new Date(c.t + (c.t.endsWith('Z') ? '' : 'Z'));
    const utcH = dt.getUTCHours();
    const utcM = dt.getUTCMinutes();
    const key  = (d => `${d.toISOString().slice(0,10)}`)(dt);

    if (utcH === 0  && utcM < 5  && !seenSessions.has(`asia-${key}`)) {
      sessions.push({ name:'Asia',   idx:i, price:c.o, color:'rgba(100,200,255,0.5)' });
      seenSessions.add(`asia-${key}`);
    }
    if (utcH === 8  && utcM < 5  && !seenSessions.has(`ldn-${key}`)) {
      sessions.push({ name:'London', idx:i, price:c.o, color:'rgba(255,200,100,0.5)' });
      seenSessions.add(`ldn-${key}`);
    }
    if (utcH === 13 && utcM < 5  && !seenSessions.has(`ny-${key}`)) {
      sessions.push({ name:'NY',     idx:i, price:c.o, color:'rgba(200,150,255,0.5)' });
      seenSessions.add(`ny-${key}`);
    }
  }

  // ── Step 6: Session high/low (previous session range) ──────────
  const sessionRanges = buildSessionRanges(candles);

  return {
    trend, swingHighs, swingLows,
    bosEvents, chochEvents, fvgs,
    sessions, sessionRanges, atr,
  };
}

function buildSessionRanges(candles) {
  // Group candles into sessions by UTC date + session slot
  const slots = { asia:{}, london:{}, ny:{} };
  for (const c of candles) {
    const dt   = new Date(c.t + (c.t.endsWith('Z') ? '' : 'Z'));
    const date = dt.toISOString().slice(0, 10);
    const h    = dt.getUTCHours();
    const slot = h < 8 ? 'asia' : h < 13 ? 'london' : 'ny';
    if (!slots[slot][date]) slots[slot][date] = { high:-Infinity, low:Infinity, candles:[] };
    slots[slot][date].candles.push(c);
    if (c.h > slots[slot][date].high) slots[slot][date].high = c.h;
    if (c.l < slots[slot][date].low)  slots[slot][date].low  = c.l;
  }
  const ranges = [];
  for (const [session, days] of Object.entries(slots)) {
    for (const [date, data] of Object.entries(days)) {
      if (data.candles.length < 2) continue;
      const firstIdx = candles.indexOf(data.candles[0]);
      const lastIdx  = candles.indexOf(data.candles[data.candles.length - 1]);
      ranges.push({ session, date, high: data.high, low: data.low, firstIdx, lastIdx });
    }
  }
  return ranges;
}

function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, lo = candles[i].l, pc = candles[i - 1].c;
    trs.push(Math.max(h - lo, Math.abs(h - pc), Math.abs(lo - pc)));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function emptyStructure() {
  return { trend:'NEUTRAL', swingHighs:[], swingLows:[], bosEvents:[], chochEvents:[], fvgs:[], sessions:[], sessionRanges:[], atr:0 };
}
