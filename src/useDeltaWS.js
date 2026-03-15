import { useState, useEffect, useRef, useCallback } from 'react';

const WS_URL    = 'wss://socket.india.delta.exchange';
const REST_BASE = 'https://api.india.delta.exchange';
const SYMBOL    = 'BTCUSD';

export function useDeltaWS() {
  const [candles,     setCandles]     = useState([]);
  const [ticker,      setTicker]      = useState(null);
  const [trades,      setTrades]      = useState([]);
  const [orderBook,   setOrderBook]   = useState({ bids: [], asks: [] });
  const [fundingRate, setFundingRate] = useState(null);
  const [status,      setStatus]      = useState('disconnected');
  const [logs,        setLogs]        = useState([
    { t: 'SYS', text: 'Δ Delta Terminal — BTCUSD Perpetual Futures', type: 'info' },
    { t: 'SYS', text: 'Type HELP for available commands', type: 'muted' },
  ]);

  const wsRef   = useRef(null);
  const pingRef = useRef(null);
  const resolutionRef = useRef('5m'); // Track resolution in a ref to avoid closure staleness in WS callback

  const log = useCallback((text, type = 'info') => {
    const t = new Date().toTimeString().slice(0, 8);
    setLogs(l => [...l.slice(-500), { t, text, type }]);
  }, []);

  // ── REST history ──────────────────────────────────────────────────────────
    // bars: number of candles to request (default 300). With 5m resolution, 300 bars = 25 hours? (actually 300*5m = 1500m = 25h)
    const fetchHistory = useCallback(async (bars = 300, resolution = '5m') => {
    try {
      resolutionRef.current = resolution;
      log(`Fetching OHLC history (${resolution})…`, 'info');
      const end   = Math.floor(Date.now() / 1000);
        // Map resolution to seconds (common cases)
        const resMap = { '1m': 60, '5m': 5 * 60, '15m': 15 * 60, '1h': 60 * 60 };
        const RES_SEC = resMap[resolution] || 5 * 60;
        const start = end - (bars * RES_SEC);
      // Use a resolution string that matches Delta's allowed values (e.g. '5m').
      const url   = `${REST_BASE}/v2/history/candles?resolution=${encodeURIComponent(resolution)}&symbol=${SYMBOL}&start=${start}&end=${end}`;
      const res   = await fetch(url);

      if (!res.ok) {
        log(`REST fetch failed: ${res.status} ${res.statusText}`, 'danger');
        return false;
      }

      let json;
      try { json = await res.json(); } catch (e) {
        log(`REST JSON parse error: ${e.message}`, 'danger');
        return false;
      }

      // Log what we got for debugging
      log(`REST response: success=${json.success ?? 'unknown'}, rows=${json.result?.length ?? 0}`, 'muted');

      if (json.success && Array.isArray(json.result) && json.result.length) {
        // Delta returns items like: { time, open, high, low, close, volume }
        const parsed = json.result.map(r => {
          // Normalize timestamp: could be seconds or milliseconds
          const raw = r.time ?? r.timestamp ?? r.t ?? 0;
          const num = Number(raw) || 0;
          const timeSec = num > 1e12 ? Math.floor(num / 1000) : Math.floor(num);
          return {
            t:  new Date(timeSec * 1000).toISOString().slice(0, 19),
            o:  Number(r.open   ?? r.o  ?? 0),
            h:  Number(r.high   ?? r.h  ?? 0),
            l:  Number(r.low    ?? r.l  ?? 0),
            c:  Number(r.close  ?? r.c  ?? 0),
            v:  Number(r.volume ?? r.v  ?? 0),
            bv: null,
            sv: null,
          };
        }).filter(r => Number(r.o) > 0 && Number(r.c) > 0)
          .sort((a, b) => a.t.localeCompare(b.t));

        setCandles(parsed);
        log(`✓ Loaded ${parsed.length} candles. Last: $${(parsed[parsed.length-1]?.c ?? 0).toFixed(1)}`, 'success');
        return true;
      } else {
        // Log first result key to understand shape
        if (json.result?.[0]) log(`REST keys: ${Object.keys(json.result[0]).join(', ')}`, 'warn');
        else log(`REST body: ${JSON.stringify(json).slice(0, 120)}`, 'warn');
        return false;
      }
    } catch (err) {
      log(`REST error: ${err?.message ?? String(err)}`, 'danger');
      return false;
    }
  }, [log]);

  // ── WebSocket ─────────────────────────────────────────────────────────────
  const connect = useCallback(() => {
    if (wsRef.current?.readyState < 2) wsRef.current.close();
    clearInterval(pingRef.current);
    setStatus('connecting');
    log(`Connecting to Delta Exchange WebSocket…`, 'info');

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('live');
      log('✓ WebSocket connected', 'success');

      // Send all subscriptions (subscribe to 1m and 5m candlesticks so we can toggle views)
      ws.send(JSON.stringify({
        type: 'subscribe',
        payload: {
          channels: [
            { name: 'v2/ticker',      symbols: [SYMBOL] },
            { name: 'all_trades',     symbols: [SYMBOL] },
            { name: 'l2_orderbook',   symbols: [SYMBOL] },
            { name: 'candlestick_1m', symbols: [SYMBOL] },
            { name: 'candlestick_5m', symbols: [SYMBOL] },
            { name: 'funding_rate',   symbols: [SYMBOL] },
            { name: 'mark_price',     symbols: [SYMBOL] },
          ],
        },
      }));

      log('Subscribed to: ticker · trades · orderbook · candlestick_5m · funding', 'muted');

      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 25_000);
    };

    // Log first few raw messages to understand actual field names
    let rawLogCount = 0;

    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg?.type) return;

      // Debug: log first 8 unique message types with their keys
      if (rawLogCount < 8 && msg.type !== 'pong') {
        log(`WS [${msg.type}] keys: ${Object.keys(msg).join(', ')}`, 'muted');
        rawLogCount++;
      }

      switch (msg.type) {

        case 'v2/ticker':
          if (msg.symbol === SYMBOL) {
            setTicker(msg);
            // Also update last candle close price from ticker
            setCandles(prev => {
              if (!prev.length) return prev;
              const p = parseFloat(msg.mark_price || msg.close || msg.last_price || 0);
              if (!p) return prev;
              const last = { ...prev[prev.length - 1] };
              last.c = p;
              if (p > last.h) last.h = p;
              if (p < last.l) last.l = p;
              return [...prev.slice(0, -1), last];
            });
          }
          break;

        case 'mark_price':
          if (msg.symbol === SYMBOL) {
            setTicker(prev => prev ? { ...prev, mark_price: msg.price ?? msg.mark_price } : { mark_price: msg.price ?? msg.mark_price });
          }
          break;

        // Delta sends candlestick updates — handle multiple possible type names
        case 'candlestick_5m':
        case 'candlestick_1m':
        case 'candlestick': {
          if (msg.symbol !== SYMBOL) break;

          // Check if this incoming candle matches our current chart resolution
          // 'candlestick_1m' vs '1m', 'candlestick_5m' vs '5m'
          const incRes = msg.type.includes('1m') ? '1m' : '5m';
          if (incRes !== resolutionRef.current) break;

          // Delta candlestick fields: time (unix seconds), open, high, low, close, volume
          const time = msg.time ?? msg.start_time ?? msg.timestamp;
          const nc = {
            t:  new Date(time * 1000).toISOString().slice(0, 19),
            o:  parseFloat(msg.open   ?? msg.o),
            h:  parseFloat(msg.high   ?? msg.h),
            l:  parseFloat(msg.low    ?? msg.l),
            c:  parseFloat(msg.close  ?? msg.c),
            v:  parseFloat(msg.volume ?? msg.v ?? 0),
            bv: null, sv: null, live: true,
          };
          if (!nc.o || !nc.c) break;
          setCandles(prev => {
            if (!prev.length) return [nc];
            const last = prev[prev.length - 1];
            // If the incoming candle has the same time as our last one, update it.
            // If it's a new time, append key.
            if (last.t === nc.t) return [...prev.slice(0, -1), nc];
            // If incoming is actually older than last, ignore it (out of order packet)
            if (new Date(nc.t) < new Date(last.t)) return prev;
            // Else it's new
            return [...prev.slice(-499), nc];
          });
          break;
        }

        case 'all_trades': {
          if (msg.symbol !== SYMBOL) break;
          const fills = Array.isArray(msg.trades) ? msg.trades : [msg];
          const mapped = fills.map(f => ({
            price: parseFloat(f.price),
            size:  parseFloat(f.size),
            side:  f.buyer_role === 'taker' || f.side === 'buy' ? 'buy' : 'sell',
            ts:    new Date().toTimeString().slice(0, 8),
            tms:   Date.now(), // epoch ms to allow time-based filtering (e.g., last 5 minutes)
          })).filter(f => f.price > 0);

          if (!mapped.length) break;
          setTrades(prev => [...mapped, ...prev].slice(0, 80));

          // Update live candle from trades
          setCandles(prev => {
            if (!prev.length) return prev;
            let last = { ...prev[prev.length - 1] };
            
            // Check for candle rollover
            // Append with 'Z' so it is parsed as UTC to match Date.now(), otherwise local timezone offset causes drift
            const lastTime = new Date(last.t.endsWith('Z') ? last.t : last.t + 'Z').getTime();
            const nowTime = Date.now();
            // Resolution in ms (default to 5m if unknown)
            const currentRes = resolutionRef.current;
            const resMs = currentRes === '1m' ? 60000 : 300000;
            const nextCandleTime = lastTime + resMs;

            // If we have passed the candle boundary, we need to create a new candle 
            // instead of updating the old one. We use the old close as the new open.
            if (nowTime >= nextCandleTime) {
               // Create a new candle starting at the correct time boundary
               // e.g. if last was 12:00 and res is 1m, next starts at 12:01.
               const newTimeStr = new Date(nextCandleTime).toISOString().slice(0, 19);
               
               const newCandle = {
                 t: newTimeStr,
                 o: last.c, // open at previous close
                 h: last.c,
                 l: last.c,
                 c: last.c,
                 v: 0,
                 bv: 0, 
                 sv: 0,
                 live: true
               };

               // Apply current trades to this NEW candle
               mapped.forEach(f => {
                 newCandle.c = f.price;
                 if (f.price > newCandle.h) newCandle.h = f.price;
                 if (f.price < newCandle.l) newCandle.l = f.price;
                 newCandle.v  += f.size;
                 newCandle.bv += (f.side === 'buy'  ? f.size : 0);
                 newCandle.sv += (f.side === 'sell' ? f.size : 0);
               });
               
               // Return list with new candle appended
               return [...prev.slice(-499), newCandle];
            } 
            
            // Otherwise update existing candle
            mapped.forEach(f => {
              last.c = f.price;
              if (f.price > last.h) last.h = f.price;
              if (f.price < last.l) last.l = f.price;
              last.v  = (last.v  || 0) + f.size;
              last.bv = (last.bv || 0) + (f.side === 'buy'  ? f.size : 0);
              last.sv = (last.sv || 0) + (f.side === 'sell' ? f.size : 0);
            });
            return [...prev.slice(0, -1), last];
          });
          break;
        }

        case 'l2_orderbook': {
          if (msg.symbol !== SYMBOL) break;
          const bids = (msg.buy  || []).slice(0, 25).map(b => [parseFloat(b.limit_price), parseFloat(b.size)]);
          const asks = (msg.sell || []).slice(0, 25).map(a => [parseFloat(a.limit_price), parseFloat(a.size)]);
          setOrderBook({ bids, asks });
          break;
        }

        case 'funding_rate':
          if (msg.symbol === SYMBOL) setFundingRate(parseFloat(msg.funding_rate));
          break;

        case 'pong':
        case 'subscriptions':
          break;

        default:
          break;
      }
    };

    ws.onerror = () => { setStatus('error'); log('WebSocket error', 'danger'); };
    ws.onclose = ev => {
      setStatus('disconnected');
      clearInterval(pingRef.current);
      log(`WebSocket closed (code ${ev.code})`, 'warn');
    };
  }, [log]);

  const disconnect = useCallback(() => {
    clearInterval(pingRef.current);
    wsRef.current?.close();
    setStatus('disconnected');
    log('Disconnected', 'warn');
  }, [log]);

  useEffect(() => {
    fetchHistory().then(connect);
    return () => { clearInterval(pingRef.current); wsRef.current?.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { candles, ticker, trades, orderBook, fundingRate, status, logs, log, connect, disconnect, fetchHistory };
}
