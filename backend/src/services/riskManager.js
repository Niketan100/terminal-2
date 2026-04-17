// backend/src/services/riskManager.js
export function getDynamicTP({ markPrice, side, originalTP, supports, resistances, atr }) {
  if (!originalTP) return { tp: null, adjusted: false, reason: '' };
  const minMove = atr ? atr * 0.5 : Math.abs(originalTP - markPrice) * 0.1;
  if (side === 'buy') {
    const inRange = resistances
      .filter(z => z.price > markPrice + minMove && z.price < originalTP - atr * 0.2 && z.touchCount >= 3)
      .sort((a, b) => b.strength - a.strength);
    if (inRange[0]) return { tp: inRange[0].price, adjusted: true,
      reason: `Resistance $${inRange[0].price.toFixed(0)} (${inRange[0].touchCount} touches) blocking path` };
  } else {
    const inRange = supports
      .filter(z => z.price < markPrice - minMove && z.price > originalTP + atr * 0.2 && z.touchCount >= 3)
      .sort((a, b) => b.strength - a.strength);
    if (inRange[0]) return { tp: inRange[0].price, adjusted: true,
      reason: `Support $${inRange[0].price.toFixed(0)} (${inRange[0].touchCount} touches) blocking path` };
  }
  return { tp: originalTP, adjusted: false, reason: '' };
}

export function getTrailingSL({ markPrice, side, currentSL, entryPrice, atr, supports, resistances }) {
  if (!atr) return currentSL;
  const nearStrongLevel = side === 'buy'
    ? resistances.some(z => z.touchCount >= 3 && z.price < markPrice + atr * 1.5 && z.price > markPrice)
    : supports.some(z => z.touchCount >= 3 && z.price > markPrice - atr * 1.5 && z.price < markPrice);
  const trail = nearStrongLevel ? atr * 1.3 : atr * 2.2;
  const newSL = side === 'buy' ? markPrice - trail : markPrice + trail;
  if (side === 'buy'  && newSL > (currentSL || -Infinity)) return +newSL.toFixed(1);
  if (side === 'sell' && newSL < (currentSL || Infinity))  return +newSL.toFixed(1);
  return currentSL;
}
