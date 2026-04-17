// backend/src/services/microstructure.js
import { toMs } from '../utils/time.js';

export function analyzeMicrostructure(trades = [], orderBook = {}, windowMs = 120000) {
  if (!trades || !trades.length) return {
    delta: 0, deltaRatio: 0, obImbalance: 0, score: 0,
    bias: 'NEUTRAL', recentTrades: 0, absorbed: false,
    buyVol: 0, sellVol: 0, divergence: null, ok: false,
  };

  const now = Date.now();
  const recent = trades.filter(t => {
    const ts = toMs(t.tms || t.timestamp || 0);
    return ts > 0 && ts >= now - windowMs;
  });

  let buyVol = 0, sellVol = 0;
  for (const t of recent) {
    const sz   = parseFloat(t.size || t.quantity || t.qty || 0);
    const side = (t.taker_side || t.side || '').toLowerCase();
    if (side === 'buy')  buyVol  += sz;
    else if (side === 'sell') sellVol += sz;
  }

  const delta = buyVol - sellVol;
  const tot   = buyVol + sellVol || 1;
  const dr    = delta / tot;

  const bids = (orderBook.bids || []).slice(0, 15);
  const asks = (orderBook.asks || []).slice(0, 15);
  const bw   = bids.reduce((s, b) => s + (parseFloat(b[1]) || 0), 0);
  const aw   = asks.reduce((s, a) => s + (parseFloat(a[1]) || 0), 0);
  const obi  = (bw - aw) / ((bw + aw) || 1);

  const score = dr * 0.6 + obi * 0.4;

  const prices = recent.map(t => parseFloat(t.price || 0)).filter(Boolean);
  const pm     = prices.length > 1
    ? Math.abs(prices[0] - prices[prices.length - 1]) / (prices[prices.length - 1] || 1)
    : 0;
  const absorbed = tot > 10 && pm < 0.0008;

  let divergence = null;
  if (recent.length >= 10) {
    const firstHalf  = recent.slice(Math.floor(recent.length / 2));
    const secondHalf = recent.slice(0, Math.floor(recent.length / 2));
    const priceDir   = (parseFloat(recent[0].price) - parseFloat(recent[recent.length - 1].price));
    let d1 = 0, d2 = 0;
    for (const t of firstHalf)  { const s = (t.side||'').toLowerCase(); const sz = parseFloat(t.size||0); if (s==='buy') d1+=sz; else d1-=sz; }
    for (const t of secondHalf) { const s = (t.side||'').toLowerCase(); const sz = parseFloat(t.size||0); if (s==='buy') d2+=sz; else d2-=sz; }
    const deltaDir = d2 - d1;
    if (priceDir > 0 && deltaDir < -tot * 0.1) divergence = 'BEARISH_DIV';
    if (priceDir < 0 && deltaDir > tot * 0.1)  divergence = 'BULLISH_DIV';
  }

  return {
    delta: +delta.toFixed(2), deltaRatio: +dr.toFixed(3),
    buyVol: +buyVol.toFixed(2), sellVol: +sellVol.toFixed(2),
    obImbalance: +obi.toFixed(3), score: +score.toFixed(3),
    absorbed, divergence,
    bias:   score > 0.15 ? 'BUY' : score < -0.15 ? 'SELL' : 'NEUTRAL',
    recentTrades: recent.length,
    ok: recent.length >= 3,
  };
}
