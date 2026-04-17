// backend/src/indicators/patterns.js
export function detectPattern(candles) {
  if (!candles || candles.length < 3) return null;
  const c = candles[candles.length - 1], p = candles[candles.length - 2];
  const range = (c.h - c.l) || 0.001, body = Math.abs(c.c - c.o);
  const uw = c.h - Math.max(c.c, c.o), lw = Math.min(c.c, c.o) - c.l;
  if (uw / range > 0.55 && body / range < 0.35 && c.c < p.c)
    return { dir: 'bear', label: 'Bearish pin', conf: Math.round(uw / range * 100) };
  if (lw / range > 0.55 && body / range < 0.35 && c.c > p.c)
    return { dir: 'bull', label: 'Bullish pin', conf: Math.round(lw / range * 100) };
  if (p.c > p.o && c.c < c.o && c.o >= p.c && c.c <= p.o)
    return { dir: 'bear', label: 'Bearish engulf', conf: 80 };
  if (p.c < p.o && c.c > c.o && c.o <= p.c && c.c >= p.o)
    return { dir: 'bull', label: 'Bullish engulf', conf: 80 };
  const l3 = candles.slice(-3);
  const ab = l3.reduce((s, x) => s + Math.abs(x.c - x.o), 0) / 3;
  const ar = l3.reduce((s, x) => s + (x.h - x.l), 0) / 3;
  const pr = candles.length > 8 ? candles.slice(-8, -3).reduce((s, x) => s + (x.h - x.l), 0) / 5 : ar * 2;
  if (ab / (ar || 1) < 0.35 && ar < pr * 0.55)
    return { dir: 'neutral', label: 'Compression', conf: 65 };
  return null;
}
