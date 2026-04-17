// backend/src/services/levelBuilder.js
import { calcATR } from '../indicators/atr.js';

export function buildInstitutionalLevels(candles, vpData) {
  if (!candles || candles.length < 30) return [];

  const n   = candles.length;
  const atr = calcATR(candles) || (candles[n - 1].h - candles[n - 1].l);
  const touchZone = atr * 0.6;

  const candidates = [];
  const lookback   = 4;
  for (let i = lookback; i < n - lookback; i++) {
    const c = candles[i];
    let isH = true, isL = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h >= c.h) isH = false;
      if (candles[j].l <= c.l) isL = false;
    }
    if (isH) candidates.push({ price: c.h, idx: i, origin: 'high' });
    if (isL) candidates.push({ price: c.l, idx: i, origin: 'low' });
  }

  const sorted = [...candidates].sort((a, b) => a.price - b.price);
  const rawZones = [];
  const used = new Set();
  for (let i = 0; i < sorted.length; i++) {
    if (used.has(i)) continue;
    const cluster = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used.has(j)) continue;
      if (Math.abs(sorted[j].price - sorted[i].price) / sorted[i].price < 0.0025) {
        cluster.push(sorted[j]); used.add(j);
      }
    }
    used.add(i);
    rawZones.push(cluster);
  }

  const scoredZones = [];
  for (const cluster of rawZones) {
    const zonePrice = cluster.reduce((s, c) => s + c.price, 0) / cluster.length;
    const touches   = [];

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const nearHigh  = Math.abs(c.h - zonePrice) <= touchZone;
      const nearLow   = Math.abs(c.l - zonePrice) <= touchZone;
      const nearClose = Math.abs(c.c - zonePrice) <= touchZone;

      if (!nearHigh && !nearLow && !nearClose) continue;
      if (touches.length > 0 && i - touches[touches.length - 1].idx < 3) continue;

      const nextCandles = candles.slice(i + 1, i + 4);
      if (!nextCandles.length) continue;

      const approachFromAbove = c.c > zonePrice;
      const approachFromBelow = c.c < zonePrice;

      let rejectionScore = 0;
      if (approachFromAbove) {
        const maxRebound = Math.max(...nextCandles.map(x => x.h)) - c.l;
        rejectionScore = maxRebound / (atr || 1);
      } else {
        const maxDropback = c.h - Math.min(...nextCandles.map(x => x.l));
        rejectionScore = maxDropback / (atr || 1);
      }

      if (rejectionScore < 0.4) continue;

      const age       = n - 1 - i;
      const ageFactor = Math.exp(-age / 80);

      touches.push({
        idx: i, candle: c,
        fromAbove: approachFromAbove,
        rejection: +rejectionScore.toFixed(2),
        ageFactor: +ageFactor.toFixed(3),
        score: +(rejectionScore * ageFactor * (1 + rejectionScore * 0.3)).toFixed(3),
      });
    }

    if (touches.length < 3) continue;

    const fromAboveCount = touches.filter(t => t.fromAbove).length;
    const fromBelowCount = touches.filter(t => !t.fromAbove).length;
    const hasRoleReversal = fromAboveCount > 0 && fromBelowCount > 0;
    const roleBonus       = hasRoleReversal ? 1.5 : 1.0;

    const rawStrength    = touches.reduce((s, t) => s + t.score, 0);
    const touchBonus     = Math.log(touches.length + 1);
    const finalStrength  = +(rawStrength * roleBonus * touchBonus).toFixed(2);
    const lastTouchIdx   = Math.max(...touches.map(t => t.idx));
    const lastTouchAge   = n - 1 - lastTouchIdx;

    scoredZones.push({
      price:          +zonePrice.toFixed(1),
      strength:       finalStrength,
      touchCount:     touches.length,
      hasRoleReversal,
      lastTouchAge,
      fromAbove:      fromAboveCount,
      fromBelow:      fromBelowCount,
      source:         'swing',
      touches,
    });
  }

  const vpLevels = vpData ? vpData.keyLevels.map(l => ({
    price: l.price, strength: l.strength * 1.5, touchCount: 0,
    hasRoleReversal: false, lastTouchAge: 0, source: l.label,
  })) : [];

  const allZones = [...scoredZones];
  for (const vp of vpLevels) {
    const near = allZones.find(z => Math.abs(z.price - vp.price) / vp.price < 0.003);
    if (near) {
      near.strength += vp.strength;
      near.source   = `${near.source}+${vp.source}`;
    } else {
      allZones.push(vp);
    }
  }

  return allZones.sort((a, b) => b.strength - a.strength);
}

export function classifyLevels(zones, price, atr) {
  const buf = atr ? atr * 0.25 : price * 0.001;
  return {
    supports:    zones.filter(z => price > z.price + buf).sort((a, b) => b.price - a.price),
    resistances: zones.filter(z => price < z.price - buf).sort((a, b) => a.price - b.price),
    atLevel:     zones.filter(z => Math.abs(z.price - price) <= (atr ? atr * 0.7 : price * 0.002)),
  };
}
