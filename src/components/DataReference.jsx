import React, { useMemo } from 'react';

/**
 * DataReference Component
 * Shows all available data being received from Delta Exchange
 * Useful for understanding the data structure and planning charts
 */
export function DataReference({ ticker, candles, trades, orderBook, fundingRate }) {
  const stats = useMemo(() => {
    if (!candles.length) return null;
    
    const latest = candles[candles.length - 1];
    const prev = candles.length > 1 ? candles[candles.length - 2] : null;
    
    return {
      candlesCount: candles.length,
      latestCandle: latest,
      prevCandle: prev,
      priceChange: latest && prev ? latest.c - prev.c : 0,
      tradesCount: trades.length,
      bidAskSpread: orderBook.bids[0] && orderBook.asks[0] 
        ? (orderBook.asks[0][0] - orderBook.bids[0][0]).toFixed(2)
        : null,
    };
  }, [candles, trades, orderBook]);

  return (
    <div style={{ padding: '12px', backgroundColor: 'rgba(0,20,40,0.6)', borderRadius: '8px', fontSize: '11px', fontFamily: 'monospace' }}>
      <div style={{ marginBottom: '8px', color: '#94a3b8', fontWeight: 'bold' }}>📊 Data Reference</div>
      
      {ticker && (
        <div style={{ marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '6px' }}>
          <div style={{ color: '#9ddfff' }}>🎯 Ticker</div>
          <div>mark_price: {ticker.mark_price}</div>
          <div>close: {ticker.close}</div>
          <div>open: {ticker.open}</div>
          <div>high: {ticker.high}, low: {ticker.low}</div>
          <div>volume: {ticker.volume}</div>
          <div>oi_value_usd: {ticker.oi_value_usd}</div>
        </div>
      )}

      {stats && (
        <div style={{ marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '6px' }}>
          <div style={{ color: '#9ddfff' }}>📈 Candles ({stats.candlesCount})</div>
          <div>Latest: O={stats.latestCandle.o} H={stats.latestCandle.h} L={stats.latestCandle.l} C={stats.latestCandle.c}</div>
          <div>Volume: {stats.latestCandle.v}, Buy: {stats.latestCandle.bv}, Sell: {stats.latestCandle.sv}</div>
          <div>Change: {stats.priceChange > 0 ? '+' : ''}{stats.priceChange.toFixed(2)}</div>
        </div>
      )}

      {trades.length > 0 && (
        <div style={{ marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '6px' }}>
          <div style={{ color: '#9ddfff' }}>🔄 Trades ({stats?.tradesCount})</div>
          <div>Latest: ${trades[0]?.price?.toFixed(2)} × {trades[0]?.size?.toFixed(4)} ({trades[0]?.side})</div>
        </div>
      )}

      {orderBook && (
        <div style={{ marginBottom: '6px', borderBottom: '1px solid rgba(255,255,255,0.05)', paddingBottom: '6px' }}>
          <div style={{ color: '#9ddfff' }}>📋 Order Book</div>
          <div>Best Bid: ${orderBook.bids[0]?.[0]?.toFixed(2)} × {orderBook.bids[0]?.[1]?.toFixed(4)}</div>
          <div>Best Ask: ${orderBook.asks[0]?.[0]?.toFixed(2)} × {orderBook.asks[0]?.[1]?.toFixed(4)}</div>
          <div>Spread: ${stats?.bidAskSpread}</div>
          <div>Bids: {orderBook.bids.length}, Asks: {orderBook.asks.length}</div>
        </div>
      )}

      {fundingRate !== null && (
        <div style={{ color: '#9ddfff' }}>
          💰 Funding Rate: {(fundingRate * 100).toFixed(4)}% 
          <span style={{ color: fundingRate >= 0 ? '#34d399' : '#f87171' }}>
            {fundingRate >= 0 ? ' (longs pay)' : ' (shorts pay)'}
          </span>
        </div>
      )}
    </div>
  );
}

export default DataReference;
