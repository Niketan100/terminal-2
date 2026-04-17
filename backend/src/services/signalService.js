// backend/src/services/signalService.js
import { calcEMA } from '../indicators/ema.js';
import { calcRSI } from '../indicators/rsi.js';
import { calcATR } from '../indicators/atr.js';
import { kalmanFilter } from '../indicators/kalman.js';
import { garch } from '../indicators/garch.js';
import { hurstExponent } from '../indicators/hurst.js';
import { volumeProfile } from '../indicators/volumeProfile.js';
import { detectPattern } from '../indicators/patterns.js';
import { analyzeMicrostructure } from './microstructure.js';
import { buildInstitutionalLevels, classifyLevels } from './levelBuilder.js';
import { detectLiquiditySweep } from './liquidity.js';
import { getDynamicTP } from './riskManager.js';
import { isLastCandleClosed } from '../utils/candles.js';

export function computeSignal(data) {
  const { candles, markPrice, trades, orderBook } = data;
  if (!candles || candles.length < 40 || !markPrice) return null;

  const closes  = candles.map(c => c.c);
  const atr     = calcATR(candles);
  const rsiVal  = calcRSI(closes);
  const pattern = detectPattern(candles);
  
  const vpData = volumeProfile(candles.slice(-100));
  const allZones = buildInstitutionalLevels(candles, vpData);
  const classified = classifyLevels(allZones, markPrice, atr);
  const { supports, resistances, atLevel } = classified;

  const longEma = calcEMA(closes, 200);
  const macroRegime = longEma ? (markPrice > longEma ? 'BULLISH' : 'BEARISH') : 'NEUTRAL';

  const candleClosed = isLastCandleClosed(candles);

  const kalman = kalmanFilter(closes.slice(-60));
  const garchR = garch(closes.slice(-80));
  const hurst  = hurstExponent(closes.slice(-60));
  const micro  = analyzeMicrostructure(trades, orderBook, 120000);

  const qualifiedZones = allZones.filter(z => (z.touchCount || 0) >= 2 || z.strength >= 4);
  const sweep = candleClosed ? detectLiquiditySweep(candles, qualifiedZones, atr) : null;

  const atQualityLevel = atLevel.filter(z => (z.touchCount || 0) >= 3 || z.source !== 'swing');
  const atSignificantLevel = atQualityLevel.length > 0;

  const kalmanScore = kalman
    ? (kalman.velocityPct > 0.02 ? 40 : kalman.velocityPct > 0.008 ? 20 :
       kalman.velocityPct < -0.02 ? -40 : kalman.velocityPct < -0.008 ? -20 : 0)
    : 0;

  const microScore = (micro && micro.ok) ? micro.score * 100 : 0;

  let divBonus = 0;
  if (micro?.divergence === 'BULLISH_DIV')  divBonus =  25;
  if (micro?.divergence === 'BEARISH_DIV')  divBonus = -25;

  const rsiScore  = rsiVal > 72 ? -30 : rsiVal < 32 ? 30 : rsiVal > 60 ? -10 : rsiVal < 42 ? 10 : 0;
  const patScore  = pattern?.dir === 'bull' ? pattern.conf * 0.4 : pattern?.dir === 'bear' ? -pattern.conf * 0.4 : 0;

  const topLevel     = atQualityLevel[0];
  const levelBoost   = atSignificantLevel
    ? 1 + Math.min(topLevel.strength * 0.08, 0.6) + (topLevel.hasRoleReversal ? 0.25 : 0)
    : 0.5;

  const garchMult  = garchR?.mult || 1.0;
  const hurstMode  = hurst?.regime || 'RANDOM';

  let rawScore = 0;
  if (hurstMode === 'TRENDING')
    rawScore = kalmanScore*0.50 + microScore*0.25 + rsiScore*0.10 + patScore*0.15;
  else if (hurstMode === 'MEAN_REV')
    rawScore = kalmanScore*0.10 + microScore*0.20 + rsiScore*0.40 + patScore*0.30;
  else
    rawScore = kalmanScore*0.30 + microScore*0.30 + rsiScore*0.20 + patScore*0.20;

  rawScore = (rawScore + divBonus) * garchMult * levelBoost;
  const compositeScore = +Math.min(100, Math.max(-100, rawScore)).toFixed(1);
  const threshold      = hurstMode === 'TRENDING' ? 22 : hurstMode === 'MEAN_REV' ? 28 : 35;

  let signal = 'HOLD', signalSource = 'quant', sweepConf = 0;

  if (sweep) {
    const trendOk = sweep.direction === 'BUY'
      ? (kalman?.trend !== 'DOWN' || sweep.sweptLevel.touchCount >= 4)
      : (kalman?.trend !== 'UP'   || sweep.sweptLevel.touchCount >= 4);
    if (trendOk) { signal = sweep.direction; signalSource = 'sweep'; sweepConf = sweep.confidence; }
  }

  if (signal === 'HOLD' && candleClosed) {
    if (compositeScore > threshold && atSignificantLevel && macroRegime !== 'BEARISH')  { signal = 'BUY';  signalSource = 'quant'; }
    if (compositeScore < -threshold && atSignificantLevel && macroRegime !== 'BULLISH') { signal = 'SELL'; signalSource = 'quant'; }
  }

  if (signal === 'HOLD' && candleClosed && atSignificantLevel && pattern) {
    const trend = kalman?.trend || 'FLAT';
    if (pattern.dir === 'bull' && trend !== 'DOWN' && rsiVal < 62 && micro?.bias !== 'SELL' && macroRegime !== 'BEARISH')
      { signal = 'BUY'; signalSource = 'level_bounce'; }
    if (pattern.dir === 'bear' && trend !== 'UP' && rsiVal > 42 && micro?.bias !== 'BUY' && macroRegime !== 'BULLISH')
      { signal = 'SELL'; signalSource = 'level_bounce'; }
  }

  let tp = null, sl = null, rr = null, tpAdjusted = false, tpReason = '';
  if (signal !== 'HOLD') {
    const side = signal === 'BUY' ? 'buy' : 'sell';
    if (side === 'buy'  && resistances[0]) tp = resistances[0].price;
    if (side === 'sell' && supports[0])    tp = supports[0].price;
    if (side === 'buy'  && supports[0])    sl = supports[0].price - (atr ? atr * 0.3 : markPrice * 0.001);
    if (side === 'sell' && resistances[0]) sl = resistances[0].price + (atr ? atr * 0.3 : markPrice * 0.001);
    if (tp) {
      const dyn = getDynamicTP({ markPrice, side, originalTP: tp, supports, resistances, atr });
      if (dyn.adjusted) { tp = dyn.tp; tpAdjusted = true; tpReason = dyn.reason; }
    }
    if (tp && sl) {
      const rew  = side === 'buy' ? tp - markPrice : markPrice - tp;
      const risk = side === 'buy' ? markPrice - sl : sl - markPrice;
      rr = risk > 0 ? +(rew / risk).toFixed(2) : null;
    }
    const minRR = signalSource === 'sweep' ? 1.2 : 1.4;
    if (!rr || rr < minRR || !tp) signal = 'HOLD';
  }

  return {
    signal, compositeScore, threshold, signalSource, sweepConf,
    sweep, candleClosed, macroRegime,
    models: { kalman, garchR, hurst, vp: vpData, micro },
    scores: { kalmanScore:+kalmanScore.toFixed(1), microScore:+microScore.toFixed(1),
              rsiScore, patScore:+patScore.toFixed(1), divBonus },
    hurstMode, garchMult, atLevel, atQualityLevel, atSignificantLevel, pattern,
    tp, sl, rr, tpAdjusted, tpReason,
    valid: signal !== 'HOLD' && tp !== null && sl !== null,
  };
}
