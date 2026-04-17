// backend/src/services/liquidity.js
export function detectLiquiditySweep(candles, zones, atr) {
  if (!candles || candles.length < 6 || !atr || !zones.length) return null;
  const last  = candles[candles.length - 1];
  const prev  = candles[candles.length - 2];
  const buf   = atr * 0.25;

  for (const z of zones) {
    // Bear sweep: prev wick pierced above zone, closed back below, last candle confirms down
    if (prev.h > z.price + buf && prev.c < z.price && last.c < last.o) {
      const bodyPct = Math.abs(last.c - last.o) / ((last.h - last.l) || 1);
      if (bodyPct > 0.28) return {
        type: 'BEAR_SWEEP', direction: 'SELL', sweptLevel: z,
        entryNote: `Swept high $${z.price.toFixed(0)} ×${z.touchCount || z.strength} touches → reversal`,
        confidence: Math.min(95, 55 + z.touchCount * 6 + Math.round(bodyPct * 30)),
      };
    }
    // Bull sweep: prev wick pierced below zone, closed back above, last candle confirms up
    if (prev.l < z.price - buf && prev.c > z.price && last.c > last.o) {
      const bodyPct = Math.abs(last.c - last.o) / ((last.h - last.l) || 1);
      if (bodyPct > 0.28) return {
        type: 'BULL_SWEEP', direction: 'BUY', sweptLevel: z,
        entryNote: `Swept low $${z.price.toFixed(0)} ×${z.touchCount || z.strength} touches → reversal`,
        confidence: Math.min(95, 55 + z.touchCount * 6 + Math.round(bodyPct * 30)),
      };
    }
  }
  return null;
}
