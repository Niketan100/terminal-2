// backend/src/indicators/volumeProfile.js
export function volumeProfile(candles, buckets = 30) {
  if (!candles || candles.length < 10) return null;
  const minP = Math.min(...candles.map(c => c.l));
  const maxP = Math.max(...candles.map(c => c.h));
  const step = (maxP - minP) / buckets || 1;
  const prof = Array.from({ length: buckets }, (_, i) => ({
    price: minP + (i + 0.5) * step,
    lo: minP + i * step, hi: minP + (i + 1) * step, vol: 0,
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
    const aL = lo > 0 ? prof[lo - 1].vol : 0, aH = hi < prof.length - 1 ? prof[hi + 1].vol : 0;
    if (aH >= aL) { hi++; acc += aH; } else { lo--; acc += aL; }
  }
  return {
    poc: +poc.price.toFixed(1), vah: +prof[hi].hi.toFixed(1), val: +prof[lo].lo.toFixed(1),
    keyLevels: [
      { price: +prof[hi].hi.toFixed(1), label: 'VAH', strength: 4 },
      { price: +poc.price.toFixed(1),   label: 'POC', strength: 5 },
      { price: +prof[lo].lo.toFixed(1), label: 'VAL', strength: 4 },
    ],
  };
}
