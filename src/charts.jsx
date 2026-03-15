import { useRef } from 'react';
import { useCanvas } from './useCanvas.js';
import { ema, rsi, macd, bb, vwap, findSR } from './indicators.js';

const C = {
  // neon / sci-fi palette
  bg:     'transparent',
  grid:   'rgba(0,200,255,0.06)',
  text:   'rgba(190,255,255,0.98)',
  bull:   '#66f7ff', // neon sky-cyan
  bear:   '#ff8aa8', // neon pink for down
  ema20:  '#8be9ff', // soft cyan
  ema50:  '#3fd6ff', // bright cyan
  bbLine: 'rgba(60,200,255,0.9)',
  bbFill: 'rgba(60,200,255,0.06)',
  vwap:   '#7be0ff',
  srS:    'rgba(0,220,255,0.18)',
  srR:    'rgba(255,100,170,0.14)',
};

// ─── Main candlestick chart ───────────────────────────────────────────────────
export function CandleChart({ candles, ind, crosshair, padLeft = 0, padRight = 0, annotations = [], startIndex = 0, dominance = 0, chartType = 'candles', yZoom = 1, glowEnabled = true, vwapData = null, min, max, hideYLabels = false }) {
  const ref = useCanvas((ctx, W, H) => {
    // Clear previous frame to avoid ghosting when canvas background is transparent
    ctx.clearRect(0, 0, W, H);
    if (!candles || candles.length < 2) {
      // ... same waiting logic ...
      if (C.bg && C.bg !== 'transparent') { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H); }
      ctx.fillStyle = 'rgba(148,163,184,0.2)';
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for candle data…', W / 2, H / 2);
      ctx.textAlign = 'left';
      return;
    }

    const closes = candles.map(c => c.c);
    const e20    = ema(closes, 20);
    const e50    = ema(closes, 50);
    const bands  = bb(closes);
    const vw     = vwapData || vwap(candles);
    const sr     = findSR(candles);

  const pL = 68, pR = 12, pT = 14, pB = 22;
  const cW = W - pL - pR;
  const cH = H - pT - pB;
  const n  = candles.length;
  // visible slots and effective slots used for x-position math
  const nVis = Math.max(1, n + (padLeft || 0) + (padRight || 0));
  // effective slots consider padLeft/padRight but we subtract 1 because positions are between 0..n-1
  const effectiveSlots = Math.max(1, n + (padLeft || 0) + (padRight || 0) - 1);

  let mn, mx;
  if (min !== undefined && max !== undefined) {
    mn = min; mx = max;
  } else {
    const allV = candles.flatMap(c => [c.h, c.l]);
    if (ind.bb) bands.forEach(b => b && allV.push(b.u, b.l));
    mn = Math.min(...allV) * 0.9985;
    mx = Math.max(...allV) * 1.0015;
  }

    // apply vertical zoom (yZoom > 1 zooms in, < 1 zooms out)
    let priceRange = mx - mn || 1;
    if (yZoom && yZoom !== 1) {
      const center = (mx + mn) / 2;
      const half = (priceRange / 2) / yZoom;
      mn = center - half;
      mx = center + half;
      priceRange = mx - mn || 1;
    }

  // Reserve a small pixel margin on the right so the currently-forming candle is not flush to the edge.
  const rightMarginPx = 48; // tuneable: how many pixels to keep as live-candle padding
  const effectiveCW = Math.max(1, cW - rightMarginPx);
  const X = i => pL + (((padLeft || 0) + i) / effectiveSlots) * effectiveCW;
    const Y = p => pT + cH - ((p - mn) / priceRange) * cH;

  // Background (transparent so page gradient shows through)
  if (C.bg && C.bg !== 'transparent') { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H); }

    // Grid lines + price labels
    const gridSteps = 6;
    for (let g = 0; g <= gridSteps; g++) {
      const y = pT + (g / gridSteps) * cH;
      const p = mx - (g / gridSteps) * priceRange;
      ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
      
      if (!hideYLabels) {
        ctx.fillStyle = C.text;
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.fillText(p.toFixed(0), 2, y + 4);
      }
    }    // ── Bollinger Bands ──────────────────────────────────────────────────────
    if (ind.bb) {
      // Fill between bands
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        if (!bands[i]) continue;
        if (!started) { ctx.moveTo(X(i), Y(bands[i].u)); started = true; }
        else ctx.lineTo(X(i), Y(bands[i].u));
      }
      for (let i = n - 1; i >= 0; i--) {
        if (!bands[i]) continue;
        ctx.lineTo(X(i), Y(bands[i].l));
      }
      ctx.closePath();
      ctx.fillStyle = C.bbFill; ctx.fill();

      // Upper / lower lines
      for (const k of ['u', 'l']) {
        ctx.beginPath(); started = false;
        for (let i = 0; i < n; i++) {
          if (!bands[i]) continue;
          if (!started) { ctx.moveTo(X(i), Y(bands[i][k])); started = true; }
          else ctx.lineTo(X(i), Y(bands[i][k]));
        }
        ctx.strokeStyle = C.bbLine; ctx.lineWidth = 1; ctx.stroke();
      }

      // Middle dashed
      ctx.beginPath(); started = false;
      for (let i = 0; i < n; i++) {
        if (!bands[i]) continue;
        if (!started) { ctx.moveTo(X(i), Y(bands[i].m)); started = true; }
        else ctx.lineTo(X(i), Y(bands[i].m));
      }
      ctx.strokeStyle = 'rgba(99,102,241,0.22)'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]); ctx.stroke(); ctx.setLineDash([]);
    }

    // ── S/R levels ───────────────────────────────────────────────────────────
    if (ind.sr) {
      sr.forEach(l => {
        const y = Y(l.p);
        ctx.strokeStyle = l.t === 'S' ? C.srS : C.srR;
        ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = l.t === 'S' ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)';
        ctx.font = '9px monospace';
        ctx.fillText(`${l.t} ${l.p.toFixed(0)}`, W - pR - 55, y - 2);
      });
    }

    // ── VWAP ─────────────────────────────────────────────────────────────────
    if (ind.vwap) {
      ctx.beginPath();
      vw.forEach((v, i) => i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)));
      ctx.strokeStyle = C.vwap; ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 3]); ctx.stroke(); ctx.setLineDash([]);
    }

    // ── EMAs ─────────────────────────────────────────────────────────────────
    if (ind.e20) {
      ctx.beginPath();
      e20.forEach((v, i) => i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)));
      ctx.strokeStyle = C.ema20; ctx.lineWidth = 1.5; ctx.stroke();
    }
    if (ind.e50) {
      ctx.beginPath();
      e50.forEach((v, i) => i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)));
      ctx.strokeStyle = C.ema50; ctx.lineWidth = 1.5; ctx.stroke();
    }

  // ── Candles or Line ───────────────────────────────────────────────────────
  const cw = Math.max(2.0, (cW / Math.max(1, nVis)) * 0.78);
  if (chartType === 'candles') {
    // stronger, filled candles (cyan = up, neon-pink glow = down)
    candles.forEach((d, i) => {
      const bull = d.c >= d.o;
      // Wick: neon tinted
      ctx.strokeStyle = bull ? 'rgba(0,150,180,0.9)' : 'rgba(255,90,140,0.9)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(X(i), Y(d.h)); ctx.lineTo(X(i), Y(d.l)); ctx.stroke();

      // Body: filled solid colors. Down candles use a neon-red with soft glow.
      const y1 = Math.min(Y(d.o), Y(d.c));
      const rh = Math.max(1.5, Math.abs(Y(d.o) - Y(d.c)));
      if (bull) {
        ctx.fillStyle = C.bull;
        ctx.fillRect(X(i) - cw / 2, y1, cw, rh);
        ctx.strokeStyle = 'rgba(0,120,150,0.9)';
        ctx.lineWidth = 1; ctx.strokeRect(X(i) - cw / 2, y1, cw, rh);
      } else {
        // soft neon pink glow
        if (glowEnabled) {
          ctx.save();
          ctx.shadowColor = 'rgba(255,90,140,0.6)';
          ctx.shadowBlur = Math.min(14, Math.max(6, cw * 1.6));
          ctx.fillStyle = C.bear;
          ctx.fillRect(X(i) - cw / 2, y1, cw, rh);
          ctx.restore();
        } else {
          ctx.fillStyle = C.bear;
          ctx.fillRect(X(i) - cw / 2, y1, cw, rh);
        }
        // crisp darker stroke on top
        ctx.strokeStyle = 'rgba(180,35,65,0.95)';
        ctx.lineWidth = 1; ctx.strokeRect(X(i) - cw / 2, y1, cw, rh);
      }
    });
  } else {
    // Line chart: single polyline through closes, with a subtle area fill and glow
    ctx.beginPath();
    candles.forEach((d, i) => {
      const x = X(i);
      const y = Y(d.c);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(102,247,255,0.95)'; ctx.lineWidth = 1.6; ctx.stroke();

    // area fill under line
    ctx.lineTo(pL + effectiveCW, H - pB);
    ctx.lineTo(pL, H - pB);
    ctx.closePath();
    ctx.fillStyle = 'rgba(102,247,255,0.06)'; ctx.fill();

    // small dots on last few points to suggest recent activity
    const lastN = Math.min(6, candles.length);
    for (let j = 0; j < lastN; j++) {
      const i = candles.length - 1 - j;
      if (i < 0) break;
      const d = candles[i];
      ctx.beginPath(); ctx.arc(X(i), Y(d.c), 2.2 - j * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = j === 0 ? 'rgba(102,247,255,0.95)' : 'rgba(102,247,255,0.45)'; ctx.fill();
    }
  }

  // ── Last price line (color matches last candle: green if bullish, red if bearish)
  const lastP = candles[n - 1].c;
  const lastOpen = candles[n - 1].o;
  const ly    = Y(lastP);
  const lastBull = lastP >= lastOpen;
  const lineColor = lastBull ? 'rgba(102,247,255,0.95)' : 'rgba(255,110,160,0.95)';
  const boxBg = lastBull ? 'rgba(0,20,24,0.85)' : 'rgba(32,4,8,0.85)';
  const boxStroke = lastBull ? 'rgba(60,200,255,0.22)' : 'rgba(255,90,140,0.22)';

  ctx.strokeStyle = lineColor; ctx.lineWidth = 1.2; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(pL, ly); ctx.lineTo(W - pR - 62, ly); ctx.stroke();
  ctx.setLineDash([]);

  // small price badge on the right, colored to match the line
  ctx.fillStyle = boxBg;
  ctx.fillRect(W - pR - 62, ly - 11, 62, 22);
  ctx.strokeStyle = boxStroke; ctx.lineWidth = 1;
  ctx.strokeRect(W - pR - 62, ly - 11, 62, 22);
  ctx.fillStyle = lastBull ? '#66f7ff' : '#ff9bbf'; ctx.font = 'bold 10px monospace';
  ctx.fillText(`$${lastP.toFixed(0)}`, W - pR - 59, ly + 5);

    // (removed: winLine marker/label to declutter UI)

    // ── Crosshair ─────────────────────────────────────────────────────────────
    if (crosshair) {
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(crosshair.x, pT); ctx.lineTo(crosshair.x, H - pB); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(pL, crosshair.y); ctx.lineTo(W - pR, crosshair.y); ctx.stroke();
      ctx.setLineDash([]);
      const cp = mn + (1 - (crosshair.y - pT) / cH) * priceRange;
      ctx.fillStyle = 'rgba(15,23,42,0.9)';
      ctx.fillRect(2, crosshair.y - 9, 64, 18);
      ctx.fillStyle = '#94a3b8'; ctx.font = '10px monospace';
      ctx.fillText(`$${cp.toFixed(0)}`, 4, crosshair.y + 4);
    }

    // ── X-axis time labels ────────────────────────────────────────────────────
    const step = Math.max(1, Math.ceil(nVis / 8));
    candles.forEach((d, i) => {
      if (i % step === 0) {
        ctx.fillStyle = 'rgba(148,163,184,0.35)';
        ctx.font = '9px monospace';
        ctx.fillText(d.t.slice(11, 16), X(i) - 12, H - 5);
      }
    });

    // ── Annotations (horizontal/trend lines) ─────────────────────────────────
    if (annotations && annotations.length) {
      annotations.forEach(a => {
        if (a.type === 'hline') {
          const y = Y(a.price);
          ctx.beginPath(); ctx.setLineDash([6,4]); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.strokeStyle = '#fb7185'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
        } else if (a.type === 'trend') {
          const ai = a.a.idx - startIndex;
          const bi = a.b.idx - startIndex;
          // skip if both points are outside current view
          if ((ai < 0 && bi < 0) || (ai >= n && bi >= n)) return;
          const Ax = X(Math.max(0, Math.min(n - 1, ai)));
          const Bx = X(Math.max(0, Math.min(n - 1, bi)));
          const Ay = Y(a.a.price);
          const By = Y(a.b.price);
          ctx.beginPath(); ctx.moveTo(Ax, Ay); ctx.lineTo(Bx, By); ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 1.6; ctx.stroke();
        }
      });
    }


    // ── Dominance bar (buy/sell dominance over last 1m) ───────────────────────
    if (typeof dominance === 'number') {
      const w = Math.min(200, Math.max(80, cW * 0.22));
      const h = 10; const x = pL; const y = pT - 14;
      const pct = Math.max(-1, Math.min(1, dominance));
      // background track
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(x, y, w, h);
      // center marker
      ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(x + w/2 - 1, y - 2, 2, h + 4);
      if (pct > 0) {
        const pw = (w/2) * (pct);
        ctx.fillStyle = 'rgba(0,230,168,0.9)';
        ctx.fillRect(x + w/2, y, pw, h);
      } else if (pct < 0) {
        const pw = (w/2) * (-pct);
        ctx.fillStyle = 'rgba(255,92,158,0.95)';
        ctx.fillRect(x + w/2 - pw, y, pw, h);
      }
      ctx.font = '10px monospace'; ctx.fillStyle = '#94a3b8';
      const label = pct > 0 ? `BUY ${Math.round(pct*100)}%` : pct < 0 ? `SELL ${Math.round(-pct*100)}%` : 'EVEN';
      ctx.fillText(label, x + w + 8, y + h - 1);
    }

  }, [candles, ind, crosshair, dominance]);
  return (
    <canvas
      ref={ref}
      style={{ width: '100%', height: '100%', display: 'block', cursor: 'crosshair' }}
    />
  );
}

// ─── Sub-chart (volume / MACD / RSI) ─────────────────────────────────────────
export function SubChart({ candles, type, padLeft = 0, padRight = 0 }) {
  const ref = useCanvas((ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    if (C.bg && C.bg !== 'transparent') { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H); }
    if (!candles || candles.length < 30) return;

    const closes = candles.map(c => c.c);
  const pL = 68, pR = 12, pT = 6, pB = 14;
  const cW = W - pL - pR;
  const cH = H - pT - pB;
  const n  = candles.length;
  const nVis = Math.max(1, n + (padLeft || 0) + (padRight || 0));
  const X  = i => pL + ((padLeft || 0) + i) / Math.max(1, (nVis - 1)) * cW;

    if (type === 'rsi') {
      const rv = rsi(closes);
      [30, 50, 70].forEach(v => {
        const y = pT + cH * (1 - v / 100);
        ctx.strokeStyle = `rgba(255,255,255,${v === 50 ? 0.07 : 0.04})`;
        ctx.lineWidth = 1; ctx.setLineDash(v !== 50 ? [3, 3] : []);
        ctx.beginPath(); ctx.moveTo(pL, y); ctx.lineTo(W - pR, y); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(148,163,184,0.35)'; ctx.font = '9px monospace';
        ctx.fillText(v, 2, y + 3);
      });
      ctx.fillStyle = 'rgba(248,113,113,0.05)';
      ctx.fillRect(pL, pT, cW, cH * (1 - 70 / 100));
      ctx.fillStyle = 'rgba(52,211,153,0.05)';
      ctx.fillRect(pL, pT + cH * (1 - 30 / 100), cW, cH * 0.3);

      ctx.beginPath();
      rv.forEach((v, i) => {
        if (v === null) return;
        const y = pT + cH * (1 - v / 100);
        i === 0 || rv[i-1] === null ? ctx.moveTo(X(i), y) : ctx.lineTo(X(i), y);
      });
      ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 1.5; ctx.stroke();

      const lr = rv[rv.length - 1];
      ctx.fillStyle = lr > 70 ? C.bear : lr < 30 ? C.bull : '#a78bfa';
      ctx.font = 'bold 10px monospace';
      ctx.fillText(`RSI ${lr?.toFixed(1) ?? '–'}`, 2, 14);
    }

    if (type === 'macd') {
      const { line, sig, hist } = macd(closes);
      const vals = [...hist.filter(Boolean), ...line, ...sig.filter(Boolean)];
      if (!vals.length) return;
      const mn = Math.min(...vals), mx = Math.max(...vals), rng = mx - mn || 1;
      const Y  = v => pT + cH * (1 - (v - mn) / rng);
  const bw = Math.max(1.0, (cW / Math.max(1, nVis)) * 0.62);

      hist.forEach((v, i) => {
        if (v === null) return;
        ctx.fillStyle = v >= 0 ? 'rgba(52,211,153,0.55)' : 'rgba(248,113,113,0.55)';
        const y1 = Math.min(Y(v), Y(0));
        ctx.fillRect(X(i) - bw / 2, y1, bw, Math.max(1, Math.abs(Y(v) - Y(0))));
      });
      ctx.beginPath();
      line.forEach((v, i) => i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)));
      ctx.strokeStyle = C.ema50; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath();
      sig.forEach((v, i) => {
        if (v === null) return;
        i === 0 || sig[i-1] === null ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v));
      });
      ctx.strokeStyle = C.ema20; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.4)'; ctx.font = '9px monospace';
      ctx.fillText('MACD', 2, 13);
    }

    if (type === 'vol') {
      const maxV = Math.max(...candles.map(c => c.v), 1);
  const bw   = Math.max(1.0, (cW / Math.max(1, nVis)) * 0.65);
      candles.forEach((d, i) => {
        const bh = (d.v / maxV) * cH;
        ctx.fillStyle = d.c >= d.o ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)';
        ctx.fillRect(X(i) - bw / 2, pT + cH - bh, bw, Math.max(1, bh));
        if (d.bv && d.v) {
          const buyH = (d.bv / d.v) * bh;
          ctx.fillStyle = 'rgba(52,211,153,0.65)';
          ctx.fillRect(X(i) - bw / 2, pT + cH - buyH, bw / 2, Math.max(1, buyH));
        }
      });
      ctx.fillStyle = 'rgba(148,163,184,0.4)'; ctx.font = '9px monospace';
      ctx.fillText('VOL', 2, 13);
    }
  }, [candles, type]);

  return <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />;
}

// ─── Order book depth ─────────────────────────────────────────────────────────
export function OrderBookChart({ bids, asks }) {
  const ref = useCanvas((ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    if (C.bg && C.bg !== 'transparent') { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H); }
    if (!bids.length || !asks.length) return;

    const all = [...bids.map(b => b[0]), ...asks.map(a => a[0])];
    const mn  = Math.min(...all), mx = Math.max(...all), pRng = mx - mn || 1;
    const maxS = Math.max(...bids.map(b => b[1]), ...asks.map(a => a[1]), 1);
    const toX  = p => ((p - mn) / pRng) * W;
    const toY  = s => H - (s / maxS) * H * 0.88 - H * 0.06;

    ctx.beginPath();
    ctx.moveTo(toX(bids[0][0]), H);
    bids.forEach(([p, s]) => ctx.lineTo(toX(p), toY(s)));
    ctx.lineTo(toX(bids[bids.length - 1][0]), H);
    ctx.closePath();
    ctx.fillStyle = 'rgba(52,211,153,0.15)'; ctx.fill();
    ctx.strokeStyle = 'rgba(52,211,153,0.55)'; ctx.lineWidth = 1.5; ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(toX(asks[0][0]), H);
    asks.forEach(([p, s]) => ctx.lineTo(toX(p), toY(s)));
    ctx.lineTo(toX(asks[asks.length - 1][0]), H);
    ctx.closePath();
    ctx.fillStyle = 'rgba(248,113,113,0.15)'; ctx.fill();
    ctx.strokeStyle = 'rgba(248,113,113,0.55)'; ctx.lineWidth = 1.5; ctx.stroke();

    const mid = (bids[0][0] + asks[0][0]) / 2;
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(toX(mid), 0); ctx.lineTo(toX(mid), H); ctx.stroke();
    ctx.setLineDash([]);
  }, [bids, asks]);

  return <canvas ref={ref} style={{ width: '100%', height: '50px', display: 'block' }} />;
}

// ─── Sparkline ────────────────────────────────────────────────────────────────
export function Sparkline({ data, color = '#34d399', height = 28 }) {
  const ref = useCanvas((ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    if (!data || data.length < 2) return;
    const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 1;
    const X  = i => (i / (data.length - 1)) * W;
    const Y  = v => H - ((v - mn) / rng) * H * 0.85 - H * 0.075;

    ctx.beginPath();
    data.forEach((v, i) => i === 0 ? ctx.moveTo(X(i), Y(v)) : ctx.lineTo(X(i), Y(v)));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = color + '22'; ctx.fill();
  }, [data, color, height]);

  return <canvas ref={ref} style={{ width: '100%', height: `${height}px`, display: 'block' }} />;
}

// ─── Aggression / Depth mini-chart ─────────────────────────────────────────
export function AggressionChart({ trades = [], bids = [], asks = [], recent = 60, compact = false }) {
  const ref = useCanvas((ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    if (C.bg && C.bg !== 'transparent') { ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H); }
    if (!trades || trades.length === 0) {
      ctx.fillStyle = 'rgba(148,163,184,0.2)'; ctx.font = '12px monospace'; ctx.fillText('No trades', W/2, H/2); return;
    }

    const t = trades.slice(-recent);

    if (compact) {
      // Compact summary: small counts + mid price
      const buys = t.filter(x => x.side === 'buy').length;
      const sells = t.filter(x => x.side === 'sell').length;
      ctx.fillStyle = 'rgba(148,163,184,0.45)'; ctx.font = '11px monospace';
      ctx.fillText(`Buys ${buys} · Sells ${sells}`, 8, 14);
      const mid = (bids[0]?.[0] || asks[0]?.[0] || 0);
      ctx.fillStyle = 'rgba(99,102,241,0.6)'; ctx.font = '10px monospace';
      ctx.fillText(`Mid ${mid ? '$'+mid.toFixed(1) : '–'}`, W - 80, 14);
      // tiny micro bars for last few trades
      const maxV = Math.max(...t.slice(-24).map(x => x.size || 0), 1);
      const pad = 6;
      const sliceT = t.slice(-24);
      const barW = Math.max(2, (W - pad * 2) / Math.max(1, sliceT.length));
      const baseY = H * 0.68;
      sliceT.forEach((tr, i) => {
        const x = pad + i * barW;
        const h = ((tr.size || 0) / maxV) * (H * 0.35);
        ctx.fillStyle = tr.side === 'buy' ? 'rgba(52,211,153,0.9)' : 'rgba(248,113,113,0.9)';
        if (tr.side === 'buy') ctx.fillRect(x, baseY - h, barW * 0.85, h);
        else ctx.fillRect(x, baseY, barW * 0.85, h);
      });
      return;
    }

    const maxV = Math.max(...t.map(x => x.size || 0), 1);
    const pad = 6;
    const barW = Math.max(2, (W - pad * 2) / Math.max(1, t.length));
    const baseY = H * 0.6;

    // Draw zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.beginPath(); ctx.moveTo(0, baseY); ctx.lineTo(W, baseY); ctx.stroke();

    // Bars for trades: buys up (green), sells down (red)
    t.forEach((tr, i) => {
      const x = pad + i * barW;
      const h = ((tr.size || 0) / maxV) * (H * 0.45);
      if (tr.side === 'buy') {
        ctx.fillStyle = 'rgba(52,211,153,0.8)';
        ctx.fillRect(x, baseY - h, barW * 0.9, h);
      } else {
        ctx.fillStyle = 'rgba(248,113,113,0.8)';
        ctx.fillRect(x, baseY, barW * 0.9, h);
      }
    });

    // Depth summary bars at bottom: aggregate top N bids/asks
    const topN = 8;
    const bb = bids.slice(0, topN).map(b => b[1] || 0);
    const aa = asks.slice(0, topN).map(a => a[1] || 0);
    const maxDepth = Math.max(...bb, ...aa, 1);
    const w2 = Math.max(20, (W - 20) / topN);
    // bids (left-to-right)
    bb.forEach((v, i) => {
      const rw = (v / maxDepth) * (w2 - 4);
      ctx.fillStyle = 'rgba(52,211,153,0.12)';
      ctx.fillRect(10 + i * w2, H - 12, rw, 8);
    });
    // asks (left-to-right)
    aa.forEach((v, i) => {
      const rw = (v / maxDepth) * (w2 - 4);
      ctx.fillStyle = 'rgba(248,113,113,0.12)';
      ctx.fillRect(10 + i * w2, H - 22, rw, 8);
    });

    // labels
    ctx.fillStyle = 'rgba(148,163,184,0.45)'; ctx.font = '10px monospace';
    ctx.fillText(`Buys: ${t.filter(x=>x.side==='buy').length}`, 6, 12);
    ctx.fillText(`Sells: ${t.filter(x=>x.side==='sell').length}`, 80, 12);
  }, [trades, bids, asks, recent, compact]);

  return <canvas ref={ref} style={{ width: '100%', height: compact ? '42px' : '80px', display: 'block' }} />;
}

// ─── Price Scale (Y-Axis) ─────────────────────────────────────────────────────
export function PriceScale({ min, max, yZoom = 1, setYZoom }) {
  const ref = useCanvas((ctx, W, H) => {
    ctx.clearRect(0, 0, W, H);
    
    // Calculate visible range based on yZoom
    let mn = min;
    let mx = max;
    let priceRange = mx - mn || 1;
    
    if (yZoom && yZoom !== 1) {
      const center = (mx + mn) / 2;
      const half = (priceRange / 2) / yZoom;
      mn = center - half;
      mx = center + half;
      priceRange = mx - mn || 1;
    }

    const pT = 14, pB = 22;
    const cH = H - pT - pB;
    const Y = p => pT + cH - ((p - mn) / priceRange) * cH;

    // Draw background
    // ctx.fillStyle = '#0f172a'; // Match chart bg if needed
    // ctx.fillRect(0, 0, W, H);

    // Draw Price Labels
    const gridSteps = 6;
    ctx.fillStyle = C.text;
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    
    for (let g = 0; g <= gridSteps; g++) {
      const y = pT + (g / gridSteps) * cH;
      const p = mx - (g / gridSteps) * priceRange;
      ctx.fillText(p.toFixed(0), 4, y);
      
      // small tick mark
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(4, y);
      ctx.stroke();
    }
  });

  const isDragging = useRef(false);
  const dragStart = useRef({ y: 0, z: 1 });

  const onWheel = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!setYZoom) return;
    const ZOOM_Factor = 0.1;
    let next = yZoom * (e.deltaY < 0 ? 1 + ZOOM_Factor : 1 - ZOOM_Factor);
    setYZoom(Math.max(0.1, Math.min(20, next)));
  };

  const onMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    isDragging.current = true;
    dragStart.current = { y: e.clientY, z: yZoom };
    
    const onMove = (mv) => {
      if (!isDragging.current) return;
      const dy = dragStart.current.y - mv.clientY;
      // Dragging UP (dy > 0) -> Zoom IN (increase Y-scale)
      // Dragging DOWN (dy < 0) -> Zoom OUT (decrease Y-scale)
      const factor = dy * 0.01;
      const next = dragStart.current.z * (1 + factor);
      setYZoom(Math.max(0.1, Math.min(20, next)));
    };
    
    const onUp = () => {
      isDragging.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', cursor: 'ns-resize', borderLeft: '1px solid ' + C.grid }} onWheel={onWheel} onMouseDown={onMouseDown}>
      <canvas ref={ref} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  );
}
