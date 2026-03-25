import React from 'react'
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useDeltaWS } from './useDeltaWS.js';
import { CandleChart, SubChart, OrderBookChart, Sparkline, AggressionChart, PriceScale } from './charts.jsx';

// Small left-panel widget: recent trades in last 5 minutes
function Live5mPanel({ trades = [], bids = [], asks = [], now }) {
  const recent = useMemo(() => trades.filter(t => t.tms && t.tms >= now - 5 * 60 * 1000), [trades, now]);
  const buys = recent.filter(t => t.side === 'buy').length;
  const sells = recent.filter(t => t.side === 'sell').length;
  const lastPrice = trades.length ? trades[0].price : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display:'flex', justifyContent:'space-between', fontSize:11 }}>
        <div style={{ color:'#9ddfff', fontWeight:700 }}>{buys}▲</div>
        <div style={{ color:'#9ddfff', fontWeight:700 }}>{sells}▼</div>
        <div style={{ color:'#bfefff', fontWeight:800 }}>{lastPrice ? `$${lastPrice.toFixed(1)}` : '–'}</div>
      </div>
      <div style={{ height: 64 }}>
        <AggressionChart trades={recent} bids={bids} asks={asks} recent={120} compact={true} />
      </div>
    </div>
  );
}
import { BotPanel } from './TradingBot.jsx';
import { rsi, macd, bb, findSR, analyzeSetup, vwap } from './indicators.js';

const STATUS_COLOR = {
  disconnected: '#475569',
  connecting:   '#fbbf24',
  live:         '#34d399',
  error:        '#f87171',
};

const LOG_COLOR = {
  info:    '#94a3b8',
  cmd:     '#e2e8f0',
  success: '#34d399',
  danger:  '#f87171',
  warn:    '#fbbf24',
  muted:   '#475569',
};

const SYMBOL = 'BTCUSD';

import OptionChain from './OptionChain.jsx';

export default function Terminal() {
  const {
    candles, ticker, trades, orderBook, fundingRate,
    status, logs, log,
    connect, disconnect, fetchHistory,
    symbol, setSymbol, availableSymbols
  } = useDeltaWS();

  // Theme: hacker (neon) or default. Persisted in localStorage as 'dt.theme'
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('dt.theme') || 'hacker'; } catch { return 'hacker'; }
  });
  useEffect(() => {
    try { localStorage.setItem('dt.theme', theme); } catch { /* ignore */ }
    // Toggle a class on body so GLOBAL_CSS can tune visuals
    if (typeof document !== 'undefined') {
      if (theme === 'hacker') document.body.classList.add('hacker'); else document.body.classList.remove('hacker');
    }
  }, [theme]);

  // UI state
  const [ind, setInd] = useState({ e20: true, e50: true, bb: true, vwap: true, sr: true });
  // subChart removed — keep only volume sub-chart for simplicity
  const [zoom, setZoom] = useState(80);
  const [crosshair, setCrosshair] = useState(null);
  const [tab, setTab] = useState('chart');
  const [cmd, setCmd] = useState('');
  const [priceHist] = useState([]);

  // panning: X-axis (time) and Y-axis (price)
  const [pan, setPan] = useState(0);
  const panRef = useRef(0);
  const [yPan, setYPan] = useState(0);
  const yPanRef = useRef(0);
  const startPanXRef = useRef(0);
  const startPanYRef = useRef(0);
  const startPanValRef = useRef(0);
  const startYPanValRef = useRef(0);
  const mainRef = useRef(null);
  const isPanningRef = useRef(false);

  // layout
  const bodyRef = useRef(null);
  const botRef = useRef(null);
  const [leftWidth, setLeftWidth] = useState(240);
  const [rightWidth, setRightWidth] = useState(300);
  // Reserve most space to main chart and a single smaller volume pane
  const [chartHeights, setChartHeights] = useState([84, 16, 0]);

  // annotations and simple demo trading
  const [annotations, setAnnotations] = useState([]); // {type:'hline'|'trend', price?, a?, b?} a/b use absolute idx
  const [placing, setPlacing] = useState(null); // 'hline' | 'trend' | null
  const placingStartRef = useRef(null);

  // chart resolution state (5m default, can toggle to 1m if data available)
  const [chartRes, setChartRes] = useState('5m');
  const [view, setView] = useState('chart'); // 'chart' | 'options'
  const [chartType, setChartType] = useState(() => { try { return localStorage.getItem('dt.chartType') || 'candles'; } catch { return 'candles'; } });
  const [yZoom, setYZoom] = useState(() => { try { return parseFloat(localStorage.getItem('dt.yZoom')) || 1; } catch { return 1; } });
  const [glowEnabled, setGlowEnabled] = useState(() => { try { return JSON.parse(localStorage.getItem('dt.glowEnabled') ?? 'true'); } catch { return true; } });
  const [showBackups, setShowBackups] = useState(false);

  const [demoBalance, setDemoBalance] = useState(10000);
  const [leverage, setLeverage] = useState(200);
  const [positions, setPositions] = useState([]); // {id, side, entry, margin, leverage, notional, qty}
  const [transactions, setTransactions] = useState([]); // record of open/closed trades
  const [showTxPanel, setShowTxPanel] = useState(false);
  const [txFilter, _setTxFilter] = useState('all'); // all | open | closed | profitable | losing
  // order quantity in BTC (e.g. 0.01)
  const [orderQty, setOrderQty] = useState(0.01);
  const [orderLots, setOrderLots] = useState(1);
  const [compactTrades, setCompactTrades] = useState(true);

  const priceUp = priceHist.length > 1 && priceHist[priceHist.length - 1] >= priceHist[0];
  const markPrice = parseFloat(ticker?.mark_price || ticker?.close || 0);
  const pctChange = ticker?.close && ticker?.open ? (parseFloat(ticker.close) - parseFloat(ticker.open)) / parseFloat(ticker.open) * 100 : null;

  // visible slice and metadata
  const nTotal = candles.length;
  // Compute right padding in candle slots. Keep it modest by default and increase when
  // the latest candle is live (being formed) so it has room while updating.
  const padLeft = 0;
  let padRight = Math.max(3, Math.round(zoom * 0.06));
  try {
    const lastVis = candles.slice(Math.max(0, nTotal - 1))[0];
    const lastIsLive = visible.length ? visible[visible.length - 1]?.live === true : lastVis?.live === true;
    if (lastIsLive) padRight = Math.max(padRight, Math.round(zoom * 0.12));
  } catch { /* ignore */ }
  const [isDimmed, setIsDimmed] = useState(false);
  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    }
  };

  const start = Math.max(0, nTotal - zoom - pan);
  const visible = candles.slice(start, Math.min(nTotal, start + zoom));

  const allVwap = useMemo(() => vwap(candles, 90), [candles]);
  const visibleVwap = allVwap.slice(start, Math.min(nTotal, start + zoom));

  // Determine min/max price for the visible window
  // Include BB if active, for consistency
  const allPrices = visible.flatMap(c => [c.h, c.l]);
  if (ind.bb) {
     const bands = bb(visible.map(c => c.c));
     bands.forEach(b => b && allPrices.push(b.u, b.l));
  }
  let baseMin = Math.min(...allPrices) * 0.9985;
  let baseMax = Math.max(...allPrices) * 1.0015;
  
  // Apply Y-pan offset to move the price range up/down
  const minPrice = baseMin + yPan;
  const maxPrice = baseMax + yPan;

  const visMeta = { start, padLeft, padRight, z: zoom };

  // small indicators for live readouts
  const closes = visible.map(c => c.c || 0);
  const rsiVals = closes.length ? rsi(closes) : [];
  const _lastRSI = rsiVals.length ? rsiVals[rsiVals.length - 1] : null;
  const macdObj = closes.length ? macd(closes) : { line: [], sig: [], hist: [] };
  const _lastMACD = macdObj.line?.length ? macdObj.line[macdObj.line.length - 1] : null;
  const bands = closes.length ? bb(closes) : null;
  const _lastBB = bands?.length ? bands[bands.length - 1] : null;

  // demo P&L calculations
  const unrealizedPnl = positions.length ? positions.reduce((s, p) => {
    const pnl = p.side === 'buy'
      ? (markPrice - p.entry) / (p.entry || 1) * p.notional
      : (p.entry - markPrice) / (p.entry || 1) * p.notional;
    return s + pnl;
  }, 0) : 0;
  const equity = demoBalance + unrealizedPnl;

  // total margin deployed across open positions
  const totalMargin = positions.reduce((s, p) => s + (p.margin || 0), 0);
  const unrealizedPct = totalMargin ? (unrealizedPnl / totalMargin) * 100 : 0;

  // Quantity / notional based open
  const openPosition = useCallback((side, qtyOverride = null) => {
    if (!markPrice || markPrice <= 0) { log('No market price yet', 'warn'); return; }
    const baseQty = typeof qtyOverride === 'number' ? qtyOverride : orderQty;
    const qty = baseQty * Math.max(1, orderLots);
    const notional = qty * markPrice;
    const margin = Math.max(1, notional / leverage);
    if (margin > demoBalance) { log('Insufficient demo balance for margin', 'danger'); return; }
    const pos = { id: Date.now(), side, entry: markPrice, margin, leverage, notional, qty };
    setPositions(p => [...p, pos]);
    setDemoBalance(b => Math.max(0, b - margin));
    // record transaction (open)
    const tx = { id: pos.id, side, entry: markPrice, entryTime: Date.now(), qty, notional, margin, leverage, orderType: 'market', status: 'open' };
    setTransactions(t => [tx, ...t]);
    log(`Opened ${side.toUpperCase()} ${qty.toFixed(4)} BTC @ ${markPrice.toFixed(1)} (margin ${margin.toFixed(2)})`, 'info');
  }, [markPrice, orderQty, orderLots, leverage, demoBalance, log]);

  const closePosition = useCallback((id) => {
    setPositions(ps => {
      const pos = ps.find(x => x.id === id);
      if (!pos) return ps;
      const current = markPrice;
      const pnl = pos.side === 'buy'
        ? pos.qty * (current - pos.entry)
        : pos.qty * (pos.entry - current);
      // return margin + pnl
      setDemoBalance(b => b + pos.margin + pnl);
      log(`Closed ${pos.side.toUpperCase()} P&L ${pnl.toFixed(2)}`, 'info');
      // update transaction record with exit info
      setTransactions(ts => ts.map(tx => tx.id === pos.id ? { ...tx, exit: current, exitTime: Date.now(), pnl, status: 'closed' } : tx));
      return ps.filter(x => x.id !== id);
    });
  }, [markPrice, log]);

  // Persist transactions and chartRes to localStorage
  useEffect(() => {
    try {
      // load account snapshot if present (includes demoBalance, positions, transactions)
      const acctRaw = localStorage.getItem('dt.account');
      if (acctRaw) {
        try {
          const acct = JSON.parse(acctRaw);
          if (typeof acct.demoBalance === 'number') setDemoBalance(acct.demoBalance);
          if (Array.isArray(acct.positions)) setPositions(acct.positions);
          if (Array.isArray(acct.transactions)) setTransactions(acct.transactions);
          if (acct.chartRes) setChartRes(acct.chartRes);
          if (acct.chartType) setChartType(acct.chartType);
          if (acct.yZoom) setYZoom(acct.yZoom);
          if (typeof acct.glowEnabled === 'boolean') setGlowEnabled(acct.glowEnabled);
        } catch { /* ignore malformed account */ }
      } else {
        const raw = localStorage.getItem('dt.transactions');
        if (raw) setTransactions(JSON.parse(raw));
        const savedRes = localStorage.getItem('dt.chartRes');
        if (savedRes) setChartRes(savedRes);
      }
    } catch { /* ignore */ }
  }, []);

  // Save current account snapshot and rotate previous snapshot into backups (keep last 5)
  const saveAccountSnapshot = useCallback(() => {
    try {
      const acctKey = 'dt.account';
      // Build current account object
      const acct = { demoBalance, positions, transactions, chartRes, chartType, yZoom, glowEnabled, savedAt: Date.now() };
      // If an existing account snapshot exists, push it into accountSnapshots
      try {
        const prev = localStorage.getItem(acctKey);
        if (prev) {
          const snapsKey = 'dt.accountSnapshots';
          const raw = localStorage.getItem(snapsKey);
          const snaps = raw ? JSON.parse(raw) : [];
          snaps.unshift({ savedAt: Date.now(), data: JSON.parse(prev) });
          // keep only last 5
          while (snaps.length > 5) snaps.pop();
          localStorage.setItem(snapsKey, JSON.stringify(snaps));
        }
      } catch { /* ignore snapshot rotation errors */ }

      localStorage.setItem(acctKey, JSON.stringify(acct));
    } catch { /* ignore */ }
  }, [demoBalance, positions, transactions, chartRes, chartType, yZoom, glowEnabled]);

  useEffect(() => { saveAccountSnapshot(); }, [demoBalance, positions, transactions, saveAccountSnapshot]);

  useEffect(() => {
    try { localStorage.setItem('dt.chartType', chartType); } catch { /* ignore */ }
  }, [chartType]);

  useEffect(() => {
    try { localStorage.setItem('dt.yZoom', String(yZoom)); } catch { /* ignore */ }
  }, [yZoom]);

  useEffect(() => {
    try { localStorage.setItem('dt.glowEnabled', JSON.stringify(glowEnabled)); } catch { /* ignore */ }
  }, [glowEnabled]);

  useEffect(() => {
    try { localStorage.setItem('dt.chartRes', chartRes); } catch { /* ignore */ }
  }, [chartRes]);

  // CSV export for transactions
  const exportTransactionsCSV = useCallback(() => {
    if (!transactions || !transactions.length) return;
    const hdr = ['id','side','qty','notional','margin','leverage','orderType','status','entry','entryTime','exit','exitTime','pnl'];
    const rows = transactions.map(tx => [
      tx.id, tx.side, tx.qty, tx.notional, tx.margin, tx.leverage, tx.orderType, tx.status,
      tx.entry ?? '', tx.entryTime ? new Date(tx.entryTime).toISOString() : '', tx.exit ?? '', tx.exitTime ? new Date(tx.exitTime).toISOString() : '', tx.pnl ?? ''
    ].map(v => typeof v === 'string' ? `"${v.replace(/"/g,'""') }"` : v));
    const csv = [hdr.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `transactions_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`; a.click(); URL.revokeObjectURL(url);
  }, [transactions]);

  // Account export/import helpers
  const importInputRef = useRef(null);

  const exportAccount = useCallback(() => {
    try {
      const acct = { demoBalance, positions, transactions, chartRes, chartType, yZoom, glowEnabled, exportedAt: Date.now() };
      const blob = new Blob([JSON.stringify(acct, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `niketa_account_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      log('Exported account snapshot', 'info');
    } catch { log('Failed to export account', 'danger'); }
  }, [demoBalance, positions, transactions, chartRes, chartType, yZoom, glowEnabled, log]);

  const handleImportFile = useCallback((ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || '{}'));
        if (!window.confirm('Importing an account snapshot will overwrite current local account state (positions, balance, transactions). Continue?')) {
          importInputRef.current.value = '';
          return;
        }
        // backup current account before overwrite
        try { saveAccountSnapshot(); } catch { /* ignore */ }
        if (typeof data.demoBalance === 'number') setDemoBalance(data.demoBalance);
        if (Array.isArray(data.positions)) setPositions(data.positions);
        if (Array.isArray(data.transactions)) setTransactions(data.transactions);
        if (data.chartRes) setChartRes(data.chartRes);
        if (data.chartType) setChartType(data.chartType);
        if (data.yZoom) setYZoom(data.yZoom);
        if (typeof data.glowEnabled === 'boolean') setGlowEnabled(data.glowEnabled);
        log('Imported account snapshot', 'success');
      } catch { log('Failed to parse imported file', 'danger'); }
      importInputRef.current.value = '';
    };
    reader.onerror = () => { log('Failed to read file', 'danger'); importInputRef.current.value = ''; };
    reader.readAsText(f);
  }, [saveAccountSnapshot, log]);

  // keyboard shortcuts: Z = reset y-zoom, L = toggle chart type, G = toggle glow
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'z' || e.key === 'Z') {
        setYZoom(1);
      } else if (e.key === 'l' || e.key === 'L') {
        setChartType(t => t === 'line' ? 'candles' : 'line');
      } else if (e.key === 'g' || e.key === 'G') {
        setGlowEnabled(g => !g);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setYZoom, setChartType, setGlowEnabled]);

  const getSnapshots = useCallback(() => {
    try {
      const raw = localStorage.getItem('dt.accountSnapshots');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }, []);

  const restoreSnapshot = useCallback((idx) => {
    try {
      const snaps = getSnapshots();
      const snap = snaps[idx];
      if (!snap) return;
      if (!window.confirm('Restore this backup? This will overwrite current local account state.')) return;
      const data = snap.data || snap;
      // backup current before restoring
      try { saveAccountSnapshot(); } catch { /* ignore */ }
      if (typeof data.demoBalance === 'number') setDemoBalance(data.demoBalance);
      if (Array.isArray(data.positions)) setPositions(data.positions);
      if (Array.isArray(data.transactions)) setTransactions(data.transactions);
      if (data.chartRes) setChartRes(data.chartRes);
      if (data.chartType) setChartType(data.chartType);
      if (data.yZoom) setYZoom(data.yZoom);
      if (typeof data.glowEnabled === 'boolean') setGlowEnabled(data.glowEnabled);
      log('Restored account snapshot', 'success');
      setShowBackups(false);
    } catch { log('Failed to restore snapshot', 'danger'); }
  }, [getSnapshots, saveAccountSnapshot, log]);

  const deleteSnapshot = useCallback((idx) => {
    try {
      const snapsKey = 'dt.accountSnapshots';
      const snaps = getSnapshots();
      snaps.splice(idx, 1);
      localStorage.setItem(snapsKey, JSON.stringify(snaps));
      log('Deleted backup', 'muted');
    } catch { log('Failed to delete backup', 'danger'); }
  }, [getSnapshots, log]);

  // filtered transactions list
  const filteredTransactions = useMemo(() => {
    if (!transactions) return [];
    switch (txFilter) {
      case 'open': return transactions.filter(t => t.status === 'open');
      case 'closed': return transactions.filter(t => t.status === 'closed');
      case 'profitable': return transactions.filter(t => t.status === 'closed' && (t.pnl||0) > 0);
      case 'losing': return transactions.filter(t => t.status === 'closed' && (t.pnl||0) <= 0);
      default: return transactions;
    }
  }, [transactions, txFilter]);

  // orderbook derived values
  const bids = orderBook?.bids || [];
  const asks = orderBook?.asks || [];
  const bidWall = bids.reduce((s, b) => s + (b?.[1] || 0), 0);
  const askWall = asks.reduce((s, a) => s + (a?.[1] || 0), 0);
  const obImbalance = (bidWall + askWall) === 0 ? 50 : (bidWall / (bidWall + askWall)) * 100;
  const spreadPct = bids[0] && asks[0] ? (((asks[0][0] - bids[0][0]) / ((asks[0][0] + bids[0][0]) / 2)) * 100).toFixed(2) : null;

  // Aggression: last 1-minute buy/sell aggregated volumes (size * price = notional)
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const lastMinuteAgg = useMemo(() => {
    const oneMinAgo = nowTick - 60 * 1000;
    const recent = (trades || []).filter(t => t.tms && t.tms >= oneMinAgo);
    let buyVol = 0, sellVol = 0;
    for (const t of recent) {
      const size = parseFloat(t.size || 0) || 0;
      const price = parseFloat(t.price || 0) || 0;
      const notional = size * price; // weight by notional
      if (t.side === 'buy') buyVol += notional;
      else sellVol += notional;
    }
    return { buyVol, sellVol, total: buyVol + sellVol };
  }, [trades, nowTick]);

  // percentages for display
  const buyPct = lastMinuteAgg.total ? Math.round((lastMinuteAgg.buyVol / lastMinuteAgg.total) * 100) : 50;
  const sellPct = 100 - buyPct;
  // dominance: -1 (all sell) .. 0 .. +1 (all buy)
  const dominance = lastMinuteAgg.total ? (lastMinuteAgg.buyVol - lastMinuteAgg.sellVol) / Math.max(1, lastMinuteAgg.total) : 0;

  const fmt = (n) => {
    if (!n) return '0';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return Math.round(n).toString();
  };

  // logs scroll ref
  const logsEndRef = useRef(null);
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [logs]);

  // shrink right panel when compacting trades to give main chart more horizontal room
  useEffect(() => {
    // increased default widths per user request
    if (compactTrades) setRightWidth(260);
    else setRightWidth(320);
  }, [compactTrades]);

  // Ensure panels never hide main content: clamp left/right widths on window resize
  useEffect(() => {
    const clampWidths = () => {
      if (!bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      const total = Math.max(320, rect.width || window.innerWidth);
  const minMain = 420; // minimum allowed width for main chart to avoid hidden elements (reduced so side panels can grow)
      const gutter = 6 + 1 + 6; // left resizer + right resizer + small buffer
      const maxSideTotal = Math.max(0, total - minMain - gutter);
      // keep left and right at most maxSideTotal proportionally
      const currentSideTotal = leftWidth + rightWidth;
      if (currentSideTotal > maxSideTotal) {
        const ratio = maxSideTotal / currentSideTotal || 0.5;
        setLeftWidth(Math.max(80, Math.round(leftWidth * ratio)));
        setRightWidth(Math.max(80, Math.round(rightWidth * ratio)));
      }
    };
    clampWidths();
    window.addEventListener('resize', clampWidths);
    return () => window.removeEventListener('resize', clampWidths);
  }, [leftWidth, rightWidth]);

  // When transaction panel (or other side windows) open, make room by increasing right panel width
  useEffect(() => {
    if (!bodyRef.current) return;
    try {
      const rect = bodyRef.current.getBoundingClientRect();
      const total = Math.max(320, rect.width || window.innerWidth);
      const minMain = 420;
      const gutter = 6 + 1 + 6;
      const maxSideTotal = Math.max(0, total - minMain - gutter);
      if (showTxPanel) {
        const desiredRight = 480; // match transaction panel width so main chart isn't hidden (give a bit more room)
        const allowedRight = Math.min(Math.max(80, desiredRight), maxSideTotal);
        setRightWidth(r => Math.min(allowedRight, Math.max(r, 80)));
      } else {
        // restore a sane default when closed (but respect compactTrades)
        if (!compactTrades) setRightWidth(w => Math.min(w, 320));
      }
    } catch { /* ignore */ }
  }, [showTxPanel, compactTrades, leftWidth]);

  // ── Crosshair ─────────────────────────────────────────────────────────────
  const onMouseMove = useCallback(e => {
    // Don't update crosshair while panning (dragging to move chart)
    if (isPanningRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setCrosshair({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  // Wheel to zoom (vertical wheel). Use a multiplicative scale for smooth zoom.
  const handleWheel = useCallback((e) => {
    // Shift (or Meta) + wheel -> vertical (Y) zoom; otherwise wheel modifies X/time zoom
    const mul = 1.08;
    const dir = e.deltaY > 0 ? 1 : -1; // positive deltaY = wheel down (zoom out)
    if (e.shiftKey || e.metaKey) {
      e.preventDefault();
      setYZoom(y => {
        const next = y * (dir > 0 ? 1 / mul : mul);
        const clamped = Math.max(0.25, Math.min(8, next));
        return Math.round(clamped * 1000) / 1000;
      });
      return;
    }
    // regular wheel -> horizontal/time zoom
    if (e.altKey) return; // let alt+wheel be default scrolling
    e.preventDefault();
    setZoom(z => {
      const next = Math.round(z * (dir > 0 ? mul : 1 / mul));
      return Math.max(20, Math.min(300, next));
    });
  }, [setZoom, setYZoom]);

  // Start panning on mousedown inside main chart area (both X and Y)
  const onMainMouseDown = useCallback(e => {
    if (e.button !== 0) return; // only left button
    isPanningRef.current = true;
    startPanXRef.current = e.clientX;
    startPanYRef.current = e.clientY;
    startPanValRef.current = panRef.current;
    startYPanValRef.current = yPanRef.current;
    // set up panning handlers for the main chart (X and Y)
    const startPanX = startPanXRef.current;
    const startPanY = startPanYRef.current;
    const startPanVal = startPanValRef.current;
    const startYPanVal = startYPanValRef.current;
    const onMove = mv => {
      // X-axis panning (time/horizontal)
      const dx = Math.round((mv.clientX - startPanX) / 6); // slowdown factor for smoother pan
      const nextPan = Math.max(0, startPanVal + dx);
      panRef.current = nextPan;
      setPan(nextPan);
      
      // Y-axis panning (price/vertical) - drag down to move price up, drag up to move price down
      const dy = mv.clientY - startPanY;
      const nextYPan = startYPanVal + dy * 0.5; // scale for comfortable dragging
      yPanRef.current = nextYPan;
      setYPan(nextYPan);
    };
    const onUp = () => {
      isPanningRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // Helper: compute absolute data index and price from client coords inside main chart
  const getDataFromClientXY = useCallback((clientX, clientY) => {
    const rect = mainRef.current?.getBoundingClientRect(); if (!rect) return null;
    const W = rect.width, H = rect.height;
    const pL = 68, pR = 12, pT = 14, pB = 22;
    const cW = W - pL - pR, cH = H - pT - pB;
    const n = candles.length;
    const padRight = Math.max(5, Math.round(zoom * 0.2));
    const padLeft = 0;
    const start = Math.max(0, n - zoom - panRef.current);
    const z = zoom;
    const nVis = Math.max(1, z + padLeft + padRight);
    const frac = (clientX - rect.left - pL) / cW;
    const idxFloat = frac * (nVis - 1) - padLeft;
    const relIdx = Math.round(idxFloat);
    const idx = Math.max(0, Math.min(n - 1, start + relIdx));
    const visible = candles.slice(start, Math.min(n, start + z));
    const allV = visible.length ? visible.flatMap(c => [c.h, c.l]) : [0, 1];
    const mn = Math.min(...allV) * 0.9985;
    const mx = Math.max(...allV) * 1.0015;
    const priceRange = mx - mn || 1;
    const price = mn + (1 - (clientY - rect.top - pT) / cH) * priceRange;
    return { idx, price, start };
  }, [candles, zoom, panRef]);

  // Double-click inside main chart to place annotations when in placing mode
  const onMainDoubleClick = useCallback(e => {
    if (!placing) return;
    const d = getDataFromClientXY(e.clientX, e.clientY);
    if (!d) return;
    if (placing === 'hline') {
      setAnnotations(a => [...a, { type: 'hline', price: d.price }]);
      setPlacing(null);
    } else if (placing === 'trend') {
      if (!placingStartRef.current) {
        placingStartRef.current = d;
      } else {
        const a = placingStartRef.current; const b = d;
        setAnnotations(xs => [...xs, { type: 'trend', a: { idx: a.idx, price: a.price }, b: { idx: b.idx, price: b.price } }]);
        placingStartRef.current = null;
        setPlacing(null);
      }
    }
  }, [placing, getDataFromClientXY]);

  

  const startHResize = useCallback((e) => {
    // single separator between main and volume pane
    e.preventDefault();
    const startY = e.clientY;
    const startHeights = [...chartHeights];
    const onMove = mv => {
      if (!bodyRef.current) return;
      const rect = bodyRef.current.getBoundingClientRect();
      const total = rect.height - 40;
      if (total <= 0) return;
      const deltaPct = ((mv.clientY - startY) / total) * 100;
      const min = 6;
      let h0 = Math.max(min, Math.min(96 - min, startHeights[0] + deltaPct));
      let h1 = Math.max(min, Math.min(96 - h0, startHeights[1] - deltaPct));
      setChartHeights([h0, h1, 0]);
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [chartHeights]);

  // Vertical resizer between panels (left or right)
  const startVResize = useCallback((which, e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startLeft = leftWidth;
    const startRight = rightWidth;
    const onMove = mv => {
      if (!bodyRef.current) return;
      if (which === 'left') {
        const nw = Math.max(80, Math.min(600, startLeft + (mv.clientX - startX)));
        setLeftWidth(nw);
      } else {
        const nw = Math.max(80, Math.min(600, startRight - (mv.clientX - startX)));
        setRightWidth(nw);
      }
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [leftWidth, rightWidth]);

  // ── Terminal commands ─────────────────────────────────────────────────────
  const handleCmd = useCallback(e => {
    if (e.key !== 'Enter') return;
    const raw = cmd.trim();
    setCmd('');
    if (!raw) return;
    log(`> ${raw}`, 'cmd');
    const [op, ...args] = raw.toUpperCase().split(' ');

    switch (op) {
      case 'HELP':
        ['CONNECT      — reconnect WebSocket',
         'DISCONNECT   — close WebSocket',
         'RELOAD       — re-fetch REST history',
         'ZOOM <N>     — visible candles (20–300)',
         'ANALYZE      — run setup analysis',
         'SR           — support/resistance levels',
         'OB           — order book snapshot',
         'FUNDING      — funding rate',
         'TRADES <N>   — show last N trades',
         'CLEAR        — separator line',
        ].forEach(l => log(l, 'muted'));
        break;
      case 'CONNECT':    connect();       break;
      case 'DISCONNECT': disconnect();    break;
      case 'RELOAD':     fetchHistory();  break;
      case 'CLEAR':      log('─'.repeat(50), 'muted'); break;
      case 'ZOOM': {
        const n = parseInt(args[0]);
        if (n >= 20 && n <= 300) { setZoom(n); log(`Zoom → ${n} candles`, 'success'); }
        else log('Usage: ZOOM <20–300>', 'danger');
        break;
      }
      case 'ANALYZE': {
        if (!visible.length) { log('No candle data yet', 'danger'); break; }
        const setup = analyzeSetup(visible);
        if (!setup) { log('Need ≥ 30 candles', 'warn'); break; }
        log(`━━ SETUP — ${SYMBOL} ━━`, 'info');
        log(`  Bias:        ${setup.bias}`, setup.bias === 'BULLISH' ? 'success' : setup.bias === 'BEARISH' ? 'danger' : 'info');
        log(`  Confidence:  ${setup.confidence}%`, setup.confidence > 60 ? 'success' : 'warn');
        log(`  Entry:       $${setup.entry.toFixed(1)}`, 'info');
        log(`  Stop Loss:   $${setup.sl.toFixed(1)}`, 'danger');
        log(`  Take Profit: $${setup.tp.toFixed(1)}`, 'success');
        setup.signals.forEach(s => log(`  • ${s.t}`, s.bull === true ? 'success' : s.bull === false ? 'danger' : 'muted'));
        break;
      }
      case 'SR': {
        const levels = findSR(visible);
        if (!levels.length) { log('No clear S/R in current zoom', 'warn'); break; }
        log('━━ SUPPORT / RESISTANCE ━━', 'info');
        levels.forEach(l => log(`  ${l.t === 'S' ? 'SUPPORT  ' : 'RESIST   '} $${l.p.toFixed(1)}`, l.t === 'S' ? 'success' : 'danger'));
        break;
      }
      case 'OB': {
        if (!bids.length) { log('No order book data yet', 'warn'); break; }
        log('━━ ORDER BOOK ━━', 'info');
        log(`  Best Bid:  $${bids[0]?.[0]?.toFixed(1)} × ${bids[0]?.[1]?.toFixed(0)}`, 'success');
        log(`  Best Ask:  $${asks[0]?.[0]?.toFixed(1)} × ${asks[0]?.[1]?.toFixed(0)}`, 'danger');
        if (spreadPct) log(`  Spread:    ${spreadPct}%`, 'muted');
        log(`  Bid Wall:  ${bidWall.toFixed(0)}`, 'success');
        log(`  Ask Wall:  ${askWall.toFixed(0)}`, 'danger');
        log(`  Imbalance: ${obImbalance.toFixed(1)}% bid-side`, obImbalance > 55 ? 'success' : obImbalance < 45 ? 'danger' : 'muted');
        break;
      }
      case 'FUNDING':
        log(fundingRate !== null
          ? `Funding (8h): ${(fundingRate * 100).toFixed(4)}%  ${fundingRate >= 0 ? '(longs pay)' : '(shorts pay)'}`
          : 'Funding not received yet', fundingRate !== null ? 'info' : 'warn');
        break;
      case 'TRADES': {
        const n = parseInt(args[0]) || 10;
        trades.slice(0, n).forEach(t =>
          log(`  ${t.ts}  $${t.price.toFixed(1)}  ×${t.size}  ${t.side.toUpperCase()}`, t.side === 'buy' ? 'success' : 'danger')
        );
        break;
      }
      default:
        log(`Unknown: ${op}  (type HELP)`, 'danger');
    }
  }, [cmd, log, connect, disconnect, fetchHistory, visible, bids, asks, spreadPct, bidWall, askWall, obImbalance, fundingRate, trades]);

  return (
    <div style={S.root}>
      <style>{GLOBAL_CSS}</style>

      {/* HEADER */}
      <header style={S.header}>
        <div style={S.brand}>
          <div style={{ ...S.dot, background: STATUS_COLOR[status] }} className={status === 'live' ? 'pulse' : ''} />
          <span style={S.logo}>NiKEta Terminal</span>
          <span style={S.sub}>{symbol} · 5M</span>
        </div>
        {/* removed thin divider to declutter top-left */}

        {/* Symbol Switcher */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginLeft: 12 }}>
          {availableSymbols.slice(0, 6).map(s => (
            <button
              key={s}
              className={`btn ${symbol === s ? 'btn-on' : ''}`}
              onClick={() => {
                setSymbol(s);
                fetchHistory(300, '5m');
                log(`Switched to ${s}`, 'success');
              }}
              style={{ fontSize: 10, padding: '4px 8px' }}
            >
              {s.replace('USD', '')}
            </button>
          ))}
        </div>

        {markPrice > 0 && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: pctChange >= 0 ? '#34d399' : '#f87171' }}>
              ${markPrice.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
            </span>
            {pctChange !== null && (
              <span style={{ fontSize: 11, fontWeight: 600, color: pctChange >= 0 ? '#34d399' : '#f87171' }}>
                {pctChange >= 0 ? '+' : ''}{pctChange.toFixed(2)}%
              </span>
            )}
          </div>
        )}

        {ticker && (
          <div style={{ display: 'flex', gap: 12 }}>
            {[['H', parseFloat(ticker.high||0).toFixed(0), '#34d399'],
              ['L', parseFloat(ticker.low||0).toFixed(0),  '#f87171'],
              ['OI', parseFloat(ticker.oi_value_usd||0).toLocaleString('en', {notation:'compact',maximumFractionDigits:1}), '#94a3b8'],
            ].map(([k,v,c]) => (
              <span key={k} style={{ fontSize: 10 }}>
                <span style={{ color: '#334155' }}>{k} </span>
                <span style={{ color: c, fontWeight: 600 }}>{v}</span>
              </span>
            ))}
            {fundingRate !== null && (
              <span style={{ fontSize: 10 }}>
                <span style={{ color: '#334155' }}>FR </span>
                <span style={{ color: fundingRate >= 0 ? '#34d399' : '#f87171', fontWeight: 600 }}>{(fundingRate * 100).toFixed(4)}%</span>
              </span>
            )}
              {/* Top navigation: move chart controls and misc buttons here to reduce clutter */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: 8 }} className="top-nav">
              <div style={{ display: 'flex', gap: 6 }}>
                <button className={`btn ${chartRes==='1m' ? 'btn-on' : ''}`} onClick={async () => {
                  const next = '1m';
                  setChartRes(next);
                  const ok = await fetchHistory(300, next);
                  if (!ok) log(`Failed to load ${next} history`, 'warn'); else log(`Switched chart to ${next}`, 'success');
                }}>1m</button>
                <button className={`btn ${chartRes==='5m' ? 'btn-on' : ''}`} onClick={async () => {
                  const next = '5m';
                  setChartRes(next);
                  const ok = await fetchHistory(300, next);
                  if (!ok) log(`Failed to load ${next} history`, 'warn'); else log(`Switched chart to ${next}`, 'success');
                }}>5m</button>
              </div>
              <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.03)' }} />
              <button className={`btn ${showTxPanel ? 'btn-on' : ''}`} onClick={() => setShowTxPanel(s => !s)}>Transactions</button>
              <button className="btn" onClick={() => exportAccount()}>Export</button>
              <input ref={importInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={handleImportFile} />
              <button className="btn" onClick={() => importInputRef.current?.click()}>Import</button>
              <button className={`btn ${showBackups ? 'btn-on' : ''}`} onClick={() => setShowBackups(s => !s)}>Backups</button>
              <button className={`btn ${view === 'options' ? 'btn-on' : ''}`} onClick={() => setView(v => v === 'chart' ? 'options' : 'chart')}>{view === 'options' ? 'Back to Chart' : 'Option Chain'}</button>
              <button className={`btn ${chartType === 'line' ? 'btn-on' : ''}`} onClick={() => setChartType(t => t === 'line' ? 'candles' : 'line')}>{chartType === 'line' ? 'Line' : 'Candles'}</button>
              <button className={`btn ${glowEnabled ? 'btn-on' : ''}`} onClick={() => setGlowEnabled(g => !g)}>{glowEnabled ? 'Glow' : 'No Glow'}</button>
              <button className="btn" onClick={() => { status === 'live' ? disconnect() : connect(); }}>{status === 'live' ? 'Disconnect' : 'Connect'}</button>
              <button className={`btn ${theme === 'hacker' ? 'btn-on' : ''}`} onClick={() => setTheme(t => t === 'hacker' ? 'default' : 'hacker')}>{theme === 'hacker' ? 'Hacker' : 'Default'}</button>
            </div>
          </div>
        )}

        <div style={{ flex: 1 }} />
        <div style={{ width: 90, height: 26 }}>
          <Sparkline data={priceHist.slice(-60)} color={priceUp ? '#34d399' : '#f87171'} height={26} />
        </div>
          <div style={{ marginLeft: 12, color: '#94a3b8', fontSize: 11 }}>Hotkeys: Z Reset Y · L Toggle Chart · G Toggle Glow</div>
        <div style={S.divider} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ color: STATUS_COLOR[status], fontSize: 10, fontWeight: 700, letterSpacing: '.08em' }}>
            {status.toUpperCase()}
          </span>
          {status === 'live'
            ? <button className="btn btn-red"   onClick={disconnect}>DISCONNECT</button>
            : <button className="btn btn-green" onClick={connect}>CONNECT</button>
          }
          <button className="btn" onClick={fetchHistory}>↺ RELOAD</button>
          <button className="btn" onClick={() => setIsDimmed(d => !d)} title="Dull Screen">🔆</button>
          <button className="btn" onClick={toggleFullScreen} title="Full Screen">⛶</button>
        </div>
      </header>

      {isDimmed && <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.5)', zIndex:9999, pointerEvents:'none', transition:'opacity 0.3s' }} />}

      {/* BODY */}
      <div ref={bodyRef} style={{ ...S.body, gridTemplateColumns: view === 'options' ? '1fr' : `${leftWidth}px 6px 1fr 6px ${rightWidth}px` }}>

  {/* LEFT: controls + indicators + live 5m activity */}
  <aside style={{ ...S.leftPanel, display: view === 'options' ? 'none' : 'block' }} className="left-panel-accent">
          <div className="phdr">Controls</div>
          <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {[40,80,120,200].map(n => (
                <button key={n} className={`btn ${zoom===n?'btn-on':''}`} onClick={() => setZoom(n)}>{n}</button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              {[300,600,1200].map(b => (
                <button key={b} className="btn" onClick={() => { fetchHistory(b); setPan(0); log(`Requested ${b} bars`, 'muted'); }}>{b}</button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => setCompactTrades(c => !c)}>{compactTrades ? 'Aggro: Compact' : 'Aggro: Expand'}</button>
              <button className="btn" onClick={() => setAnnotations([])}>Clear Lines</button>
            </div>

            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
              {/* Indicator toggles */}
              {[[ 'e20', 'EMA 20' ], [ 'e50', 'EMA 50' ], [ 'bb', 'Bollinger' ], [ 'vwap', 'VWAP' ], [ 'sr', 'Sup/Res' ]].map(([k, lbl]) => (
                <button key={k} className={`btn ${ind[k] ? 'btn-on' : ''}`} onClick={() => setInd(p => ({ ...p, [k]: !p[k] }))} style={{ fontSize:11, padding:'6px 8px' }}>{lbl}</button>
              ))}
            </div>
          </div>

          <div className="phdr">Aggro · 1m</div>
          <div style={{ padding: '8px' }}>
            <div className="agg-bars" style={{ height: 72 }}>
              <div className="agg-bar buy">
                <div className="val">{fmt(lastMinuteAgg.buyVol)}</div>
                <div className="bar" style={{ height: `${buyPct}%`, minHeight: 6 }} />
                <div className="lbl">Buy</div>
              </div>
              <div className="agg-bar sell">
                <div className="val">{fmt(lastMinuteAgg.sellVol)}</div>
                <div className="bar" style={{ height: `${sellPct}%`, minHeight: 6 }} />
                <div className="lbl">Sell</div>
              </div>
            </div>
          </div>

          <div className="phdr">Live · 5m</div>
          <div style={{ padding: '6px 8px' }}>
            {/* recent trades over last 5 minutes */}
            <Live5mPanel trades={trades} bids={orderBook?.bids||[]} asks={orderBook?.asks||[]} now={nowTick} />
          </div>

          {/* Compact buy/sell percentage summary (below streaming trades) */}
          <div style={{ padding: '6px 8px' }}>
            <div className="agg-summary">
              <div className="agg-sel buy">Buy <span className="pct">{buyPct}%</span></div>
              <div className="agg-sel sell">Sell <span className="pct">{sellPct}%</span></div>
            </div>
          </div>
  </aside>

     {/* vertical resizer between left and main */}
     <div style={{ cursor: 'col-resize', width: 6, background: 'transparent', display: view === 'options' ? 'none' : 'block' }}
       onMouseDown={e => startVResize('left', e)} />

     {/* MAIN */}
     <main style={S.main}>
          {view === 'options' ? <OptionChain /> : (
            <>
          <div style={S.tabBar}>
            {[['chart','📈 Chart'],['terminal','⌨ Terminal']].map(([t,l]) => (
              <button key={t} className={`tab ${tab===t?'tab-on':''}`} onClick={() => setTab(t)}>{l}</button>
            ))}
            <div style={{ flex:1 }} />
            <div style={{ display:'flex', gap:8, padding:'3px 0', alignItems:'center' }}>
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <div style={{ color:'#94a3b8', fontSize:11 }}>Balance</div>
                  <div style={{ color:'#e2e8f0', fontWeight:700 }}>${demoBalance.toFixed(2)}</div>
                </div>
                <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.03)' }} />
                <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                  <button className={`btn ${placing==='trend' ? 'btn-on' : ''}`} onClick={() => { setPlacing(p => p === 'trend' ? null : 'trend'); placingStartRef.current = null; }}>Trend</button>
                  {/* Chart resolution controls moved to the top nav to reduce clutter */}
                </div>
            </div>
          </div>

          {tab === 'chart' && (
            <div style={S.chartArea} className="chart-panel" >
              {/* Top-left dominance bar removed per user request */}
              {/* Main candle — adjustable */}
        <div ref={mainRef} style={{ flex: `0 0 ${chartHeights[0]}%`, minHeight:0, position:'relative', display: 'flex', flexDirection: 'row' }}
          onMouseDown={onMainMouseDown} onDoubleClick={onMainDoubleClick} onMouseMove={onMouseMove} onMouseLeave={() => setCrosshair(null)} onWheel={handleWheel}>
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                <CandleChart candles={visible} ind={ind} crosshair={crosshair}
                             padLeft={visMeta.padLeft} padRight={visMeta.padRight} annotations={annotations} startIndex={visMeta.start}
                             winLine={markPrice} dominance={dominance} chartType={chartType} yZoom={yZoom} glowEnabled={glowEnabled}
                             vwapData={visibleVwap} min={minPrice} max={maxPrice} hideYLabels={true} />
                <div style={{ position:'absolute', top:8, right:8, background:'rgba(2,6,23,0.6)', padding:'6px 8px', borderRadius:6, display:'flex', gap:8, alignItems:'center', zIndex:8, fontSize:11, color:'#e6faff' }}>
                  <div>Y-Zoom: {yZoom.toFixed(2)}x</div>
                  <button className="btn" onClick={() => setYZoom(1)} style={{ padding:'4px 6px' }}>Reset</button>
                </div>
                {showBackups && (
                  <div style={{ position:'absolute', left:12, top:8, zIndex:50 }}>
                    <div style={{ background:'rgba(1,6,14,0.96)', padding:10, borderRadius:6, minWidth:320, boxShadow:'0 6px 24px rgba(0,0,0,0.5)' }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                        <div style={{ fontWeight:700 }}>Backups</div>
                        <div><button className="btn" onClick={() => setShowBackups(false)}>Close</button></div>
                      </div>
                      <div style={{ maxHeight:300, overflowY:'auto', display:'flex', flexDirection:'column', gap:4 }}>
                        {getSnapshots && getSnapshots().length === 0 && <div style={{ color:'#94a3b8' }}>No backups</div>}
                        {getSnapshots && getSnapshots().map((s, i) => (
                          <div key={i} style={{ display:'flex', justifyContent:'space-between', gap:8, padding:'6px 4px', borderBottom:'1px solid rgba(255,255,255,0.02)' }}>
                            <div style={{ fontSize:12 }}>
                              <div style={{ color:'#94a3b8' }}>{new Date(s.t || s.data?.savedAt || s.exportedAt || Date.now()).toLocaleString()}</div>
                              <div style={{ color:'#7f9fb5', fontSize:11 }}>{(s.data?.positions ? s.data.positions.length : (s.positions ? s.positions.length : 0))} positions</div>
                            </div>
                            <div style={{ display:'flex', gap:6 }}>
                              <button className="btn" onClick={() => restoreSnapshot(i)}>Restore</button>
                              <button className="btn" onClick={() => deleteSnapshot(i)}>Delete</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                {status === 'live' && (
                  <div style={S.liveBadge}>
                    <div style={{ width:5, height:5, borderRadius:'50%', background:'#34d399' }} className="pulse" />
                    <span style={{ color:'#34d399', fontSize:9, letterSpacing:'.12em' }}>LIVE</span>
                  </div>
                )}
              </div>
              <div style={{ width: 50, borderLeft: '1px solid rgba(255,255,255,0.1)', background: 'rgba(2,6,23,0.3)', zIndex: 10 }}>
                <PriceScale min={minPrice} max={maxPrice} yZoom={yZoom} setYZoom={setYZoom} />
              </div>
        </div>
              {/* horizontal resizer between main and volume pane */}
              <div style={{ height: 8, cursor: 'row-resize', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                   onMouseDown={startHResize}>
                <div style={{ width: '40%', height: 2, background: 'rgba(255,255,255,0.03)', borderRadius:2 }} />
              </div>

              {/* Volume sub-chart only (simplified) */}
              <div style={{ flex: `0 0 ${chartHeights[1]}%`, minHeight:0 }}>
                <SubChart candles={visible} type={'vol'} padLeft={visMeta.padLeft} padRight={visMeta.padRight} />
              </div>
            </div>
          )}

          {tab === 'terminal' && (
            <div style={S.termArea} className="chart-panel">
              <div style={S.logScroll}>
                {logs.map((l, i) => (
                  <div key={i} style={{ display:'flex', gap:10, marginBottom:1 }}>
                    <span style={{ color:'#1e3a5f', flexShrink:0, fontSize:10, minWidth:54 }}>{l.t}</span>
                    <span style={{ color: LOG_COLOR[l.type] || '#94a3b8', wordBreak:'break-word' }}>{l.text}</span>
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
              <div style={S.cmdRow}>
                <span style={{ color:'#3b82f6', fontWeight:700, fontSize:16, lineHeight:1 }}>›</span>
                <input type="text" value={cmd} onChange={e => setCmd(e.target.value)} onKeyDown={handleCmd}
                  placeholder="HELP · CONNECT · ANALYZE · SR · OB · ZOOM 80…"
                  style={S.cmdInput} autoFocus />
              </div>
            </div>
          )}
        </>
      )}
     </main>

     {/* vertical resizer between main and right */}
     <div style={{ cursor: 'col-resize', width: 6, background: 'transparent', display: view === 'options' ? 'none' : 'block' }}
       onMouseDown={e => startVResize('right', e)} />

  {/* RIGHT */}
  <aside style={{ ...S.rightPanel, display: view === 'options' ? 'none' : 'block' }} className="right-panel-accent">
          <div className="phdr">Market</div>
          <div style={{ padding:'8px 10px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ color:'#1e3a5f', fontSize:10 }}>Mark</div>
              <div style={{ fontWeight:800, fontSize:14, color:'#e6faff' }}>{ticker ? `$${parseFloat(ticker.mark_price||0).toFixed(1)}` : '–'}</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ color:'#1e3a5f', fontSize:10 }}>Spread</div>
              <div style={{ fontWeight:700, color:'#9ddfff' }}>{spreadPct ? `${spreadPct}%` : '–'}</div>
            </div>
          </div>

          <div style={{ padding: '8px 10px' }}>
            <div className="phdr">P&L</div>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'8px 0' }}>
              <div>
                <div style={{ color:'#94a3b8', fontSize:11 }}>Unrealized</div>
                <div style={{ fontWeight:800, color: unrealizedPnl >= 0 ? '#00ffe1' : '#ff7ab0' }}>${unrealizedPnl.toFixed(2)} <span style={{ fontSize:11, color:'#94a3b8' }}>({unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(2)}%)</span></div>
              </div>
              <div>
                <div style={{ color:'#94a3b8', fontSize:11 }}>Equity</div>
                <div style={{ fontWeight:800 }}>${equity.toFixed(2)}</div>
              </div>
            </div>
          </div>

          <div className="phdr">Positions</div>
            <div style={{ padding:'8px 10px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
              <div>
                <div style={{ color:'#94a3b8', fontSize:11 }}>Open PnL</div>
                <div style={{ fontWeight:800, color: unrealizedPnl >= 0 ? '#00ffe1' : '#ff7ab0' }}>${unrealizedPnl.toFixed(2)} <span style={{ fontSize:11, color:'#94a3b8' }}>({unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(2)}%)</span></div>
              </div>
              <div>
                <div style={{ color:'#94a3b8', fontSize:11 }}>Equity</div>
                <div style={{ fontWeight:800 }}>${equity.toFixed(2)}</div>
              </div>
            </div>

            {positions.length === 0 && <div style={{ color:'#5b7e93' }}>No open positions</div>}
            {positions.map(p => (
              <div key={p.id} className="pos-card">
                <div>
                  <div style={{ fontWeight:800 }}>{p.side.toUpperCase()} · {p.qty.toFixed(4)} qty</div>
                  <div style={{ color:'#94a3b8', fontSize:12 }}>Entry ${p.entry.toFixed(1)}</div>
                </div>
                <div style={{ textAlign:'right' }}>
                  <div style={{ fontWeight:800, color: (p.side==='buy' ? (markPrice - p.entry) >= 0 : (p.entry - markPrice) >= 0) ? '#00ffe1' : '#ff7ab0' }}>
                    {(() => {
                      const pnl = (p.side==='buy' ? (markPrice - p.entry) * p.qty : (p.entry - markPrice) * p.qty);
                      const pct = p.margin ? (pnl / p.margin) * 100 : 0;
                      return `${pnl.toFixed(2)} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
                    })()}
                  </div>
                  <div style={{ marginTop:8 }}>
                    <button className="btn" onClick={() => closePosition(p.id)}>Close</button>
                  </div>
                </div>
                
              </div>
              
            ))}
                         <BotPanel
  candles={candles}
  ref={botRef}
  markPrice={markPrice}
  openPosition={openPosition}
  closePosition={closePosition}
  positions={positions}
  log={log}
/>
          </div>
        
          {/* Compact Trade section merged into right panel to reduce clutter */}
          <div className="phdr">Trade</div>
          <div style={{ padding: '8px 10px', borderTop: '1px solid rgba(255,255,255,0.02)', marginTop:8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize:11, color:'#94a3b8' }}>Aggro · 1m</div>
              <div style={{ fontSize:12, fontWeight:800, color: dominance >= 0 ? '#00ffe1' : '#ff7ab0' }}>{dominance >= 0 ? `BUY ${buyPct}%` : `SELL ${sellPct}%`}</div>
            </div>

            <div className="agg-bars" style={{ height: 48, marginBottom:8 }}>
              <div className="agg-bar buy">
                <div className="val">{fmt(lastMinuteAgg.buyVol)}</div>
                <div className="bar" style={{ height: `${buyPct}%`, minHeight:4 }} />
                <div className="lbl">Buy</div>
              </div>
              <div className="agg-bar sell">
                <div className="val">{fmt(lastMinuteAgg.sellVol)}</div>
                <div className="bar" style={{ height: `${sellPct}%`, minHeight:4 }} />
                <div className="lbl">Sell</div>
              </div>
            </div>

            <div style={{ display:'flex', gap:8, marginBottom:8 }}>
              <button className="btn btn-primary" style={{ flex:1 }} onClick={() => openPosition('buy', orderQty)}>Buy</button>
              <button className="btn btn-inverse" style={{ flex:1 }} onClick={() => openPosition('sell', orderQty)}>Sell</button>
            </div>

            <div style={{ display:'flex', gap:8, marginBottom:8 }}>
              <input className="trade-input" type="number" value={orderQty} step={0.01} onChange={e => setOrderQty(parseFloat(e.target.value)||0)} />
              <input className="trade-input" type="number" value={orderLots} min={1} step={1} onChange={e => setOrderLots(Math.max(1, parseInt(e.target.value)||1))} style={{ width: 72 }} />
              <select value={leverage} onChange={e => setLeverage(parseInt(e.target.value))} className="trade-select">
                {[1,2,5,10,20,50,100,200].map(l => <option key={l} value={l}>{l}x</option>)}
              </select>
            </div>

            <div style={{ fontSize:12, color:'#94a3b8' }}>Notional: <span style={{ color:'#e6faff', fontWeight:700 }}>{markPrice ? '$' + (orderQty * markPrice).toFixed(2) : '–'}</span> · Margin: <span style={{ color:'#e6faff', fontWeight:700 }}>{(orderQty * markPrice / Math.max(1, leverage)).toFixed(2)}</span></div>
          </div>

        </aside>

  {/* left-bottom clock widget (current time) */}
  
  <div className="left-clock"><div className="time">{new Date(nowTick).toLocaleTimeString()}</div><div className="date">{new Date(nowTick).toLocaleDateString()}</div></div>

      

      
    
      {showTxPanel && (
        <div className="tx-panel">
          <div className="tx-header">
            <span>Transactions <button className="btn" style={{ fontSize:10, padding:'2px 6px', marginLeft:8 }} onClick={exportTransactionsCSV}>CSV</button></span>
            <span className="tx-close" onClick={() => setShowTxPanel(false)}>✕</span>
          </div>
          <div className="tx-list">
            {filteredTransactions.length === 0 && <div style={{ padding:12, color:'#5b7e93' }}>No transactions yet</div>}
            {filteredTransactions.map(tx => (
              <div key={tx.id} className="tx-row">
                <div className="tx-main">
                  <div style={{ fontWeight:800 }}>{tx.side.toUpperCase()} · {tx.qty.toFixed(4)} BTC</div>
                  <div style={{ color:'#94a3b8', fontSize:12 }}>{tx.orderType} · Leverage {tx.leverage}x</div>
                </div>
                <div className="tx-meta">
                  <div style={{ fontWeight:800, color: tx.status==='closed' ? (tx.pnl>=0 ? '#00e6a8' : '#ff5c7a') : '#bfefff' }}>
                    {tx.status === 'closed' ? `$${(tx.pnl||0).toFixed(2)}` : 'OPEN'}
                  </div>
                  <div style={{ fontSize:12, color:'#94a3b8' }}>{tx.status === 'closed' ? new Date(tx.exitTime).toLocaleString() : new Date(tx.entryTime).toLocaleString()}</div>
                </div>
                <div className="tx-detail">
                  <div>Entry: ${tx.entry.toFixed(1)} · Notional: ${fmt(tx.notional)}</div>
                  {tx.status === 'closed' && <div>Exit: ${tx.exit.toFixed(1)} · PnL: ${ (tx.pnl||0).toFixed(2) }</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
        
      )}

      </div>

    </div>
    
  );
}

const S = {
  root:       { background:'transparent', height:'100vh', color:'#bffaff', fontFamily:'JetBrains Mono, Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif', fontSize:13, display:'flex', flexDirection:'column', overflow:'hidden' },
  header:     { display:'flex', alignItems:'center', gap:12, padding:'8px 16px', borderBottom:'1px solid rgba(0,0,0,0.12)', background:'transparent', flexShrink:0, flexWrap:'wrap' },
  brand:      { display:'flex', alignItems:'center', gap:8 },
  logo:       { color:'#66f0ff', fontWeight:800, fontSize:14, letterSpacing:'.12em' },
  sub:        { color:'rgba(159,229,255,0.18)', fontSize:11 },
  dot:        { width:8, height:8, borderRadius:'50%', flexShrink:0 },
  divider:    { width:1, height:18, background:'#111a26', flexShrink:0 },
  body:       { display:'grid', gridTemplateColumns:'240px 1fr 300px', flex:1, overflow:'hidden', minHeight:0 },
  leftPanel:  { borderRight:'1px solid #111a26', display:'flex', flexDirection:'column', overflow:'auto' },
  rightPanel: { borderLeft:'1px solid #111a26', display:'flex', flexDirection:'column', overflow:'auto', padding: '6px 0', gap: 6 },
  main:       { display:'flex', flexDirection:'column', overflow:'hidden', minHeight:0 },
  tabBar:     { display:'flex', borderBottom:'1px solid #111a26', padding:'0 10px', flexShrink:0, alignItems:'center' },
  chartArea:  { flex:1, display:'flex', flexDirection:'column', minHeight:0, padding:'3px 3px 0' },
  termArea:   { flex:1, display:'flex', flexDirection:'column', minHeight:0 },
  logScroll:  { flex:1, overflow:'auto', padding:'10px 14px', lineHeight:'1.6' },
  cmdRow:     { borderTop:'1px solid #111a26', padding:'7px 12px', display:'flex', alignItems:'center', gap:8, flexShrink:0 },
  cmdInput:   { background:'transparent', border:'none', color:'#e2e8f0', fontFamily:'inherit', fontSize:12, outline:'none', width:'100%' },
  sep:        { flex:'0 0 1px', background:'#111a26', margin:'2px 0' },
  liveBadge:  { position:'absolute', top:8, left:78, display:'flex', alignItems:'center', gap:5, background:'linear-gradient(90deg, rgba(0,255,209,0.06), rgba(255,123,212,0.03))', padding:'2px 8px', borderRadius:6, border:'1px solid rgba(75,225,255,0.12)', boxShadow:'0 4px 18px rgba(75,225,255,0.06)' },
};

const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: radial-gradient(circle at 10% 10%, #05040a, #081025 60%); }
  ::-webkit-scrollbar-thumb { background: linear-gradient(180deg,#1b3a4a,#102435); border-radius: 8px; border: 1px solid rgba(255,255,255,0.02); box-shadow: 0 4px 16px rgba(124,92,255,0.08); }
  .btn { background:linear-gradient(90deg, rgba(124,92,255,0.06), rgba(110,240,255,0.02)); border:1px solid rgba(124,92,255,0.18); color:#dffbff; cursor:pointer; padding:6px 12px; border-radius:10px; font-family:inherit; font-size:12px; transition:all .12s; box-shadow: 0 8px 28px rgba(60,40,120,0.36); }
  .btn:hover { transform: translateY(-2px); box-shadow: 0 16px 40px rgba(124,92,255,0.14); border-color: rgba(124,92,255,0.34); color:#ffffff; }
  .btn-on { background: linear-gradient(90deg,#6ef0ff22,#d19bff18) !important; border-color:#b992ff !important; color:#ffffff !important; box-shadow: 0 8px 36px rgba(124,92,255,0.14) !important; }
  .btn-green { background: linear-gradient(90deg, rgba(0,255,209,0.12), rgba(110,240,255,0.04)) !important; border-color: rgba(0,255,209,0.22) !important; color:#00ffe1 !important; }
  .btn-red { background: linear-gradient(90deg, rgba(255,92,158,0.12), rgba(255,123,212,0.04)) !important; border-color: rgba(255,92,158,0.22) !important; color:#ff7ab0 !important; }
  .tab { background:none; border:none; border-bottom:2px solid transparent; color:#9ddfff; cursor:pointer; font-family:inherit; font-size:12px; padding:9px 14px; letter-spacing:.1em; text-transform:uppercase; transition:all .12s; }
  .tab-on { border-bottom-color:#b68bff !important; color:#ffffff !important; text-shadow: 0 8px 30px rgba(182,139,255,0.12); }
  .phdr { color:#89b2c6; font-size:10px; letter-spacing:.12em; text-transform:uppercase; padding:8px 12px; border-bottom:1px solid rgba(255,255,255,0.03); background: linear-gradient(180deg, rgba(14,16,30,0.28), rgba(10,12,20,0.06)); flex-shrink:0; }

  /* Panel content immediately following headers gets a soft card look to partition UI */
  .phdr + div {
    background: linear-gradient(180deg, rgba(8,12,22,0.6), rgba(6,10,20,0.15));
    border: 2px solid rgba(255,255,255,0.14); /* slightly softer white border */
    border-left: 4px solid rgba(255,255,255,0.14);
    padding: 8px 10px;
    margin-bottom: 10px;
    border-radius: 10px;
    box-shadow: 0 6px 18px rgba(2,6,12,0.38);
  }

  /* Generic chart/terminal panel container (darker for better contrast) */
  .chart-panel { background: linear-gradient(180deg, rgba(2,4,8,0.26), rgba(6,10,20,0.12)); border: 1px solid rgba(255,255,255,0.04); border-radius: 10px; padding: 6px; margin: 6px; }
  .chart-panel > div { background: transparent; }

  /* Slightly different left/right accents for side panels */
  aside { padding: 6px; }
  /* Left panel: neon-cyan tint (darker) */
  .left-panel-accent { border-left: 4px solid rgba(255,255,255,0.14); background: linear-gradient(180deg, rgba(0,230,168,0.06), rgba(0,120,180,0.04)); }
  /* Right panel: neon-purple tint (darker) */
  .right-panel-accent { border-left: 4px solid rgba(255,255,255,0.14); background: linear-gradient(180deg, rgba(124,92,255,0.06), rgba(60,20,120,0.04)); }
  /* Main/chart panel: slightly darker with neon border */
  .chart-panel { background: linear-gradient(180deg, rgba(2,8,16,0.10), rgba(2,6,12,0.06)); border: 2px solid rgba(255,255,255,0.12); }
  .pos-card { padding:8px; border-radius:10px; background: linear-gradient(180deg, rgba(110,240,255,0.03), rgba(182,139,255,0.02)); margin-bottom:8px; display:flex; justify-content:space-between; align-items:center; box-shadow: inset 0 1px 0 rgba(255,255,255,0.02); }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.28} }
  .pulse { animation: pulse 1.8s ease-in-out infinite; }
  /* Top navigation in header to keep main UI clean */
  .top-nav { display:flex; gap:8px; align-items:center; }
  .top-nav .btn { padding:6px 10px; border-radius:8px; }
  /* Floating trade panel */
  .floating-trade { position: fixed; right: 18px; bottom: 18px; width: 300px; background: linear-gradient(180deg, rgba(6,10,24,0.94), rgba(8,10,18,0.78)); border: 1px solid rgba(124,92,255,0.16); padding: 12px; border-radius: 12px; box-shadow: 0 18px 48px rgba(6,10,24,0.72); backdrop-filter: blur(6px); z-index: 60; }
  .floating-trade .ft-header { font-size:12px; color:#9ddfff; margin-bottom:8px; font-weight:700; }
  .floating-trade .ft-row { display:flex; gap:8px; margin-bottom:8px; }
  .floating-trade .ft-meta { font-size:12px; color:#94a3b8; }
  /* Left-bottom clock widget */
  .left-clock { position: fixed; left: 14px; bottom: 14px; width: 180px; height: 80px; border-radius: 12px; background: linear-gradient(180deg, rgba(0,14,22,0.92), rgba(0,10,18,0.76)); border: 1px solid rgba(0,200,255,0.06); box-shadow: 0 20px 54px rgba(0,100,160,0.5); z-index: 30; display:flex; flex-direction:column; align-items:center; justify-content:center; font-family: 'JetBrains Mono', monospace; font-size:18px; color:#bfefff; padding:8px; }
  .left-clock .time { font-size:22px; font-weight:700; letter-spacing:1px; color:#bffaff; text-shadow: 0 8px 36px rgba(0,180,240,0.12); }
  .left-clock .date { font-size:11px; color:#8fd7ea; margin-top:4px; }
  /* Aggro percent summary under live trades */
  .agg-summary { display:flex; gap:8px; justify-content:space-between; align-items:center; }
  .agg-sel { flex:1; padding:8px; border-radius:8px; background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)); border:2px solid rgba(255,255,255,0.14); display:flex; justify-content:space-between; align-items:center; }
  .agg-sel.buy { border-left:4px solid rgba(0,230,168,0.18); }
  .agg-sel.sell { border-left:4px solid rgba(255,92,158,0.18); }
  .agg-sel .pct { font-weight:800; color:#e6faff; }

  /* dominance UI removed per user preference */

  /* Transactions panel */
  .tx-toggle { position: fixed; right: 22px; bottom: 20px; z-index:70; }
  .tx-panel { position: fixed; right: 22px; bottom: 72px; width: 420px; max-height: 52vh; background: linear-gradient(180deg, rgba(0,6,10,0.98), rgba(0,6,10,0.94)); border:2px solid rgba(0,160,220,0.10); border-radius:10px; box-shadow: 0 28px 68px rgba(0,60,90,0.72); z-index:80; overflow:auto; }
  .tx-header { padding:10px 12px; font-weight:800; color:#e6faff; border-bottom:1px solid rgba(255,255,255,0.03); display:flex; justify-content:space-between; align-items:center; }
  .tx-list { padding:8px; display:flex; flex-direction:column; gap:8px; }
  .tx-row { padding:8px; border-radius:8px; background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)); border:1px solid rgba(255,255,255,0.04); }
  .tx-main { display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .tx-meta { text-align:right; }
  .tx-detail { margin-top:6px; color:#94a3b8; font-size:12px; display:flex; gap:10px; justify-content:space-between; }
  .tx-close { cursor:pointer; color:#94a3b8; font-size:14px; }
  /* Input/button tweaks for floating trade */
  .trade-input { flex:1; padding:8px 10px; border-radius:8px; background: rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.03); color:#bfefff; font-family:inherit; }
  .trade-select { padding:8px 10px; border-radius:8px; background: rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.03); color:#bfefff; }
  .btn-primary { background: linear-gradient(90deg, rgba(0,255,209,0.12), rgba(110,240,255,0.04)); border-color: rgba(0,255,209,0.16); color:#00ffe1; }
  .btn-inverse { background: linear-gradient(90deg, rgba(255,92,158,0.12), rgba(255,123,212,0.03)); border-color: rgba(255,92,158,0.14); color:#ff7ab0; }
  /* Aggression mini bars inside floating trade */
  .agg-bars { display:flex; gap:8px; align-items:end; margin:6px 0 8px; height:54px; }
  .agg-bar { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; gap:6px; }
  .agg-bar .bar { width:36px; border-radius:8px 8px 4px 4px; box-shadow:0 8px 24px rgba(0,0,0,0.4); }
  .agg-bar.buy .bar { background: linear-gradient(180deg,#00f0ff,#006f98); box-shadow: 0 8px 28px rgba(0,180,240,0.12), 0 2px 6px rgba(0,0,0,0.6); }
  .agg-bar.sell .bar { background: linear-gradient(180deg,#ff8ba8,#b91c1c); box-shadow: 0 8px 28px rgba(255,80,140,0.08), 0 2px 6px rgba(0,0,0,0.6); }
  .agg-bar .lbl { font-size:11px; color:#94a3b8; }
  .agg-bar .val { font-weight:800; color:#e6faff; font-size:12px; }

  /* Hacker-mode intensification (toggled via body class 'hacker') */
  body.hacker { background: radial-gradient(1200px 600px at 8% 12%, #00121a 0%, #000814 18%, #001022 36%, #000511 100%); }
  body.hacker .chart-panel { border-color: rgba(0,200,255,0.18); box-shadow: 0 20px 60px rgba(0,100,160,0.45); }
  body.hacker .top-nav .btn-on { box-shadow: 0 14px 40px rgba(0,200,255,0.16) !important; }
  body.hacker .left-clock .time { text-shadow: 0 12px 48px rgba(0,200,255,0.18); }
`;
