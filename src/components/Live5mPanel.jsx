import { useMemo } from 'react';
import { AggressionChart } from '../charts.jsx';

// Small left-panel widget: recent trades in last 5 minutes
export default function Live5mPanel({ trades = [], bids = [], asks = [], now }) {
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
