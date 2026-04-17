// StructureOverlay.jsx
// Drop-in replacement wrapper for CandleChart that adds:
//   • Large order dots (top 1% trade size)
//   • BOS / CHoCH labels
//   • FVG boxes (unfilled = solid, filled = faded)
//   • Session open vertical lines (Asia / London / NY)
//   • Swing high/low markers
//
// Usage: replace <CandleChart ...> with <StructureOverlay ...>
// All existing CandleChart props are forwarded unchanged.
// New props: trades, structureConfig

import { useRef, useEffect, useMemo, useCallback } from 'react';
import { CandleChart } from './charts.jsx';
import { analyzeStructure, detectLargeOrders } from './useStructure.js';

// ── Coordinate helpers (MUST match charts.jsx exactly) ────────────
function makeCoords(W, H, n, padLeft, padRight, mn, mx, yZoom) {
  const pL = 68, pR = 12, pT = 14, pB = 22;
  const cW = W - pL - pR;
  const cH = H - pT - pB;

  let priceRange = mx - mn || 1;
  if (yZoom && yZoom !== 1) {
    const center = (mx + mn) / 2;
    const half   = (priceRange / 2) / yZoom;
    mn = center - half;
    mx = center + half;
    priceRange = mx - mn || 1;
  }

  const nVis          = Math.max(1, n + (padLeft || 0) + (padRight || 0));
  const effectiveSlots = Math.max(1, nVis - 1);
  const rightMarginPx  = 48;
  const effectiveCW    = Math.max(1, cW - rightMarginPx);

  const X = i => pL + (((padLeft || 0) + i) / effectiveSlots) * effectiveCW;
  const Y = p => pT + cH - ((p - mn) / priceRange) * cH;

  return { X, Y, pL, pR, pT, pB, cW, cH, mn, mx, priceRange };
}

// ── Canvas overlay renderer ────────────────────────────────────────
function drawOverlay(canvas, candles, structure, largeOrders, W, H, padLeft, padRight, mn, mx, yZoom) {
  if (!canvas || !candles || candles.length < 2) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, W, H);

  const n = candles.length;
  const { X, Y, pL, pR, pT, pB, cW, cH } = makeCoords(W, H, n, padLeft, padRight, mn, mx, yZoom);
  const canvasW = W;

  // ── Session open vertical lines ──────────────────────────────────
  if (structure.sessions) {
    for (const s of structure.sessions) {
      if (s.idx < 0 || s.idx >= n) continue;
      const x = X(s.idx);
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, pT); ctx.lineTo(x, H - pB); ctx.stroke();
      ctx.setLineDash([]);
      // Session label at top
      ctx.fillStyle = s.color;
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.fillText(s.name, x + 3, pT + 10);
      ctx.restore();
    }
  }

  // ── FVG boxes ─────────────────────────────────────────────────────
  if (structure.fvgs) {
    for (const fvg of structure.fvgs) {
      if (fvg.idx < 0 || fvg.idx >= n) continue;
      const xStart = X(fvg.idx);
      const xEnd   = fvg.filled && fvg.fillIdx < n ? X(fvg.fillIdx) : X(n - 1) + 8;
      const yTop   = Y(fvg.top);
      const yBot   = Y(fvg.bottom);
      const h      = Math.abs(yTop - yBot);
      if (h < 2) continue;

      ctx.save();
      if (fvg.filled) {
        // Filled FVG: faded, just border
        ctx.strokeStyle = fvg.type === 'BULL' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)';
        ctx.lineWidth = 0.5;
        ctx.setLineDash([3, 3]);
        ctx.strokeRect(xStart, Math.min(yTop, yBot), xEnd - xStart, h);
        ctx.setLineDash([]);
      } else {
        // Unfilled FVG: visible box
        ctx.fillStyle   = fvg.type === 'BULL' ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)';
        ctx.strokeStyle = fvg.type === 'BULL' ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)';
        ctx.lineWidth   = 0.8;
        ctx.fillRect(xStart, Math.min(yTop, yBot), xEnd - xStart, h);
        ctx.strokeRect(xStart, Math.min(yTop, yBot), xEnd - xStart, h);
        // FVG label
        ctx.fillStyle = fvg.type === 'BULL' ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.7)';
        ctx.font = '8px "JetBrains Mono", monospace';
        ctx.fillText(`FVG`, xStart + 2, Math.min(yTop, yBot) + 9);
      }
      ctx.restore();
    }
  }

  // ── Swing high/low dots ───────────────────────────────────────────
  if (structure.swingHighs) {
    for (const sh of structure.swingHighs) {
      if (sh.idx < 0 || sh.idx >= n) continue;
      const x = X(sh.idx), y = Y(sh.price) - 6;
      ctx.save();
      ctx.fillStyle = 'rgba(248,113,113,0.55)';
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
  if (structure.swingLows) {
    for (const sl of structure.swingLows) {
      if (sl.idx < 0 || sl.idx >= n) continue;
      const x = X(sl.idx), y = Y(sl.price) + 6;
      ctx.save();
      ctx.fillStyle = 'rgba(52,211,153,0.55)';
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }

  // ── BOS labels ───────────────────────────────────────────────────
  if (structure.bosEvents) {
    for (const bos of structure.bosEvents) {
      if (bos.idx < 0 || bos.idx >= n) continue;
      const x = X(bos.idx);
      const y = bos.direction === 'UP' ? Y(bos.price) - 14 : Y(bos.price) + 20;
      ctx.save();
      const col = bos.direction === 'UP' ? 'rgba(52,211,153,0.9)' : 'rgba(248,113,113,0.9)';
      // Draw line from swing level to break candle
      const sx = X(bos.swingIdx), sy = Y(bos.price);
      ctx.strokeStyle = col; ctx.lineWidth = 0.8; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(x, sy); ctx.stroke();
      ctx.setLineDash([]);
      // BOS label pill
      ctx.fillStyle   = bos.direction === 'UP' ? 'rgba(0,40,30,0.85)' : 'rgba(40,0,10,0.85)';
      ctx.strokeStyle = col; ctx.lineWidth = 0.8;
      const lw = 28, lh = 14;
      roundRect(ctx, x - lw/2, y - lh/2, lw, lh, 3);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = col;
      ctx.font = 'bold 8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('BOS', x, y + 4);
      ctx.textAlign = 'left';
      ctx.restore();
    }
  }

  // ── CHoCH labels (more prominent than BOS) ─────────────────────
  if (structure.chochEvents) {
    for (const ch of structure.chochEvents) {
      if (ch.idx < 0 || ch.idx >= n) continue;
      const x = X(ch.idx);
      const y = ch.direction === 'UP' ? Y(ch.price) - 18 : Y(ch.price) + 24;
      ctx.save();
      const col = ch.direction === 'UP' ? '#00ffe1' : '#ff7ab0';
      const bgCol = ch.direction === 'UP' ? 'rgba(0,60,50,0.9)' : 'rgba(60,0,20,0.9)';
      // Horizontal line through the level
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(X(ch.swingIdx), Y(ch.price)); ctx.lineTo(x, Y(ch.price)); ctx.stroke();
      ctx.setLineDash([]);
      // CHoCH pill (wider)
      const lw = 42, lh = 16;
      ctx.fillStyle   = bgCol;
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      roundRect(ctx, x - lw/2, y - lh/2, lw, lh, 4);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = col;
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('CHoCH', x, y + 4);
      ctx.textAlign = 'left';
      ctx.restore();
    }
  }

  // ── Large order dots ──────────────────────────────────────────────
  // Cyan = buy, pink = sell. Size of dot scales with order size.
  if (largeOrders && largeOrders.length) {
    const maxSize = Math.max(...largeOrders.map(o => o.size));
    for (const o of largeOrders) {
      if (o.candleIdx < 0 || o.candleIdx >= n) continue;
      const c   = candles[o.candleIdx];
      const x   = X(o.candleIdx);
      // Buy dots below the candle low, sell dots above the high
      const y   = o.side === 'buy' ? Y(c.l) + 10 : Y(c.h) - 10;
      // Radius: 4–10px depending on relative size
      const r   = 4 + (o.size / maxSize) * 6;
      const col = o.side === 'buy' ? '#00ffe1' : '#ff7ab0';
      const bg  = o.side === 'buy' ? 'rgba(0,255,225,0.12)' : 'rgba(255,122,176,0.12)';

      ctx.save();
      // Outer glow ring
      ctx.beginPath(); ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.fillStyle = bg; ctx.fill();
      // Core dot
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      // Size label for very large orders
      if (o.size >= o.threshold * 1.5) {
        ctx.fillStyle = col;
        ctx.font = 'bold 8px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(fmtSize(o.size), x, y + r + 10);
        ctx.textAlign = 'left';
      }
      ctx.restore();
    }
  }

  // ── Trend label (top-right) ────────────────────────────────────
  if (structure.trend && structure.trend !== 'NEUTRAL') {
    const col  = structure.trend === 'UP' ? '#00ffe1' : '#ff7ab0';
    const bg   = structure.trend === 'UP' ? 'rgba(0,40,30,0.75)' : 'rgba(40,0,10,0.75)';
    const lbl  = structure.trend === 'UP' ? '▲ UPTREND' : '▼ DOWNTREND';
    const tw   = 80, th = 16, tx = canvasW - pR - tw - 4, ty = pT + 2;
    ctx.save();
    ctx.fillStyle = bg; ctx.strokeStyle = col; ctx.lineWidth = 0.8;
    roundRect(ctx, tx, ty, tw, th, 3); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col; ctx.font = 'bold 9px "JetBrains Mono", monospace';
    ctx.textAlign = 'center'; ctx.fillText(lbl, tx + tw/2, ty + th/2 + 3); ctx.textAlign = 'left';
    ctx.restore();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.arcTo(x+w, y, x+w, y+r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x+w, y+h, x+w-r, y+h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y+h, x, y+h-r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x+r, y, r);
  ctx.closePath();
}

function fmtSize(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1)+'M';
  if (n >= 1000)    return (n/1000).toFixed(1)+'k';
  return n.toFixed(0);
}

// ═══════════════════════════════════════════════════════════════════
//  StructureOverlay component
// ═══════════════════════════════════════════════════════════════════

export function StructureOverlay({
  // All standard CandleChart props
  candles, ind, crosshair, padLeft = 0, padRight = 0,
  annotations = [], startIndex = 0, dominance = 0,
  chartType = 'candles', yZoom = 1, glowEnabled = true,
  vwapData = null, min, max, hideYLabels = false,
  // New props
  trades = [],
  structureConfig = {},
  showStructure = true,
  showLargeOrders = true,
  showFVG = true,
  showBOS = true,
  showSessions = true,
}) {
  const containerRef = useRef(null);
  const overlayRef   = useRef(null);
  const rafRef       = useRef(null);

  // Memoize structure analysis — only recomputes when candle count changes
  const prevCandleLen = useRef(0);
  const structureCache = useRef(null);
  const structure = useMemo(() => {
    if (!candles || candles.length < 10) return null;
    return analyzeStructure(candles, {
      swingLookback: structureConfig.swingLookback || 3,
      fvgMinAtr:     structureConfig.fvgMinAtr     || 0.3,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles?.length]);

  // Memoize large orders — recomputes when trades array changes
  const largeOrders = useMemo(() => {
    if (!showLargeOrders || !trades?.length || !candles?.length) return [];
    return detectLargeOrders(trades, candles, 99);
  }, [trades?.length, candles?.length, showLargeOrders]);

  // Draw overlay on canvas whenever inputs change
  const draw = useCallback(() => {
    const container = containerRef.current;
    const canvas    = overlayRef.current;
    if (!container || !canvas || !structure) return;
    const rect = container.getBoundingClientRect();
    const W    = rect.width  || container.offsetWidth;
    const H    = rect.height || container.offsetHeight;
    if (!W || !H) return;

    // Scale for device pixel ratio
    const dpr  = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width  = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width  = W + 'px';
      canvas.style.height = H + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
    }

    // Compute price range (must mirror charts.jsx logic exactly)
    let mn, mx;
    if (min !== undefined && max !== undefined) { mn = min; mx = max; }
    else {
      const allV = (candles || []).flatMap(c => [c.h, c.l]);
      mn = Math.min(...allV) * 0.9985;
      mx = Math.max(...allV) * 1.0015;
    }

    const filteredStructure = {
      ...structure,
      bosEvents:   showBOS      ? structure.bosEvents   : [],
      chochEvents: showBOS      ? structure.chochEvents : [],
      fvgs:        showFVG      ? structure.fvgs        : [],
      sessions:    showSessions ? structure.sessions    : [],
      swingHighs:  structure.swingHighs,
      swingLows:   structure.swingLows,
    };

    drawOverlay(canvas, candles, filteredStructure, largeOrders, W, H, padLeft, padRight, mn, mx, yZoom);
  }, [candles, structure, largeOrders, padLeft, padRight, min, max, yZoom, showBOS, showFVG, showSessions]);

  // Re-draw on every animation frame when running (for live price updates)
  useEffect(() => {
    const tick = () => { draw(); rafRef.current = requestAnimationFrame(tick); };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  return (
    <div ref={containerRef} style={{ position:'relative', width:'100%', height:'100%' }}>
      {/* Base chart — untouched */}
      <CandleChart
        candles={candles} ind={ind} crosshair={crosshair}
        padLeft={padLeft} padRight={padRight}
        annotations={annotations} startIndex={startIndex}
        dominance={dominance} chartType={chartType} yZoom={yZoom}
        glowEnabled={glowEnabled} vwapData={vwapData}
        min={min} max={max} hideYLabels={hideYLabels}
      />
      {/* Transparent overlay canvas — sits on top, pointer-events:none so clicks pass through */}
      <canvas
        ref={overlayRef}
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none',
          zIndex: 5,
        }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  StructurePanel — small summary panel for the right sidebar
//  Shows current trend, recent BOS/CHoCH, active FVGs
// ═══════════════════════════════════════════════════════════════════

export function StructurePanel({ candles, trades, structureConfig = {} }) {
  const structure = useMemo(() => {
    if (!candles || candles.length < 10) return null;
    return analyzeStructure(candles, structureConfig);
  }, [candles?.length]);

  const largeOrders = useMemo(() => {
    if (!trades?.length || !candles?.length) return [];
    return detectLargeOrders(trades, candles, 99);
  }, [trades?.length, candles?.length]);

  if (!structure) return null;

  const recentBOS   = [...structure.bosEvents, ...structure.chochEvents]
    .sort((a, b) => b.idx - a.idx).slice(0, 4);
  const activeFVGs  = structure.fvgs.filter(f => !f.filled).slice(-4);
  const recentBigO  = largeOrders.slice(-5);

  const trendCol = structure.trend === 'UP' ? '#00ffe1' : structure.trend === 'DOWN' ? '#ff7ab0' : '#94a3b8';

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
      <div className="phdr" style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
        <span>Structure · 5m</span>
        <span style={{ fontSize:10, fontWeight:700, color:trendCol }}>
          {structure.trend === 'UP' ? '▲' : structure.trend === 'DOWN' ? '▼' : '—'} {structure.trend}
        </span>
      </div>

      <div style={{ padding:'7px 10px', display:'flex', flexDirection:'column', gap:7 }}>

        {/* Trend + swing structure */}
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
          <div style={{ background:'rgba(255,255,255,0.02)', borderRadius:6, padding:'5px 7px', border:'1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ fontSize:9, color:'#475569' }}>Swing highs</div>
            {structure.swingHighs.slice(-2).reverse().map((sh,i) => (
              <div key={i} style={{ fontSize:11, fontWeight:700, color:'rgba(248,113,113,0.9)' }}>${sh.price.toFixed(0)}</div>
            ))}
          </div>
          <div style={{ background:'rgba(255,255,255,0.02)', borderRadius:6, padding:'5px 7px', border:'1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ fontSize:9, color:'#475569' }}>Swing lows</div>
            {structure.swingLows.slice(-2).reverse().map((sl,i) => (
              <div key={i} style={{ fontSize:11, fontWeight:700, color:'rgba(52,211,153,0.9)' }}>${sl.price.toFixed(0)}</div>
            ))}
          </div>
        </div>

        {/* Recent BOS / CHoCH */}
        {recentBOS.length > 0 && (
          <div style={{ background:'rgba(0,0,0,0.18)', borderRadius:6, padding:'6px 8px', border:'1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:4 }}>Recent structure events</div>
            {recentBOS.map((b, i) => {
              const col = b.type === 'CHoCH'
                ? (b.direction==='UP' ? '#00ffe1' : '#ff7ab0')
                : (b.direction==='UP' ? 'rgba(52,211,153,0.8)' : 'rgba(248,113,113,0.8)');
              return (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:11, padding:'2px 0',
                  borderBottom:'1px solid rgba(255,255,255,0.025)', color:col }}>
                  <span style={{ fontWeight:700 }}>{b.type} {b.direction==='UP'?'▲':'▼'}</span>
                  <span style={{ fontSize:10, color:'#334155' }}>@ ${b.price.toFixed(0)} · bar {b.idx}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Active FVGs */}
        {activeFVGs.length > 0 && (
          <div style={{ background:'rgba(0,0,0,0.18)', borderRadius:6, padding:'6px 8px', border:'1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:4 }}>Unfilled FVGs</div>
            {activeFVGs.map((f, i) => {
              const col = f.type === 'BULL' ? 'rgba(52,211,153,0.8)' : 'rgba(248,113,113,0.8)';
              return (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:11, padding:'2px 0',
                  borderBottom:'1px solid rgba(255,255,255,0.025)' }}>
                  <span style={{ color:col, fontWeight:700 }}>{f.type} FVG</span>
                  <span style={{ fontSize:10, color:'#5b7e93' }}>${f.bottom.toFixed(0)}–${f.top.toFixed(0)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Recent large orders */}
        {recentBigO.length > 0 && (
          <div style={{ background:'rgba(0,0,0,0.18)', borderRadius:6, padding:'6px 8px', border:'1px solid rgba(255,255,255,0.03)' }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:4 }}>Large orders (top 1%)</div>
            {recentBigO.map((o, i) => {
              const col = o.side === 'buy' ? '#00ffe1' : '#ff7ab0';
              return (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', fontSize:11, padding:'2px 0',
                  borderBottom:'1px solid rgba(255,255,255,0.025)' }}>
                  <span style={{ color:col, fontWeight:700 }}>{o.side.toUpperCase()}</span>
                  <span style={{ fontSize:10, color:'#5b7e93' }}>{fmtSize(o.size)} @ ${o.price.toFixed(0)}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Session lines legend */}
        <div style={{ display:'flex', gap:10, fontSize:9, color:'#334155' }}>
          <span style={{ color:'rgba(100,200,255,0.7)' }}>● Asia</span>
          <span style={{ color:'rgba(255,200,100,0.7)' }}>● London</span>
          <span style={{ color:'rgba(200,150,255,0.7)' }}>● NY</span>
        </div>

      </div>
    </div>
  );
}

/*
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  INTEGRATION GUIDE — Terminal.jsx  (5 minutes)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP 1 — Add imports at the top of Terminal.jsx:

  import { StructureOverlay, StructurePanel } from './StructureOverlay.jsx';


STEP 2 — Replace <CandleChart ...> in the main chart area with <StructureOverlay>.
  All your existing props stay identical. Just add trades and the show* toggles:

  <StructureOverlay
    candles={visible}
    ind={ind}
    crosshair={crosshair}
    padLeft={visMeta.padLeft}
    padRight={visMeta.padRight}
    annotations={annotations}
    startIndex={visMeta.start}
    dominance={dominance}
    chartType={chartType}
    yZoom={yZoom}
    glowEnabled={glowEnabled}
    vwapData={visibleVwap}
    min={minPrice}
    max={maxPrice}
    hideYLabels={true}
    trades={trades}
    showStructure={true}
    showLargeOrders={true}
    showFVG={true}
    showBOS={true}
    showSessions={true}
  />


STEP 3 — Add StructurePanel to the right sidebar (inside the right <aside>),
  before or after the Auto Bot panel:

  <StructurePanel
    candles={candles}
    trades={trades}
  />


STEP 4 (optional) — Add toggle buttons in your indicator row in the left panel
  so users can turn overlays on/off:

  const [showOverlay, setShowOverlay] = useState({
    largeOrders: true, fvg: true, bos: true, sessions: true
  });

  Then pass showOverlay.fvg etc. to StructureOverlay props.


FILES TO DROP IN YOUR src/ FOLDER:
  • StructureOverlay.jsx  (this file)
  • useStructure.js       (the analysis engine)

No changes needed to charts.jsx or useDeltaWS.js.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*/
