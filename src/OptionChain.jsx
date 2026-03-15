import React, { useState, useEffect, useMemo } from 'react';

// Formatter for currency and numbers
const format = {
  price: (n) => n ? parseFloat(n).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) : '-',
  iv: (n) => n ? (parseFloat(n) * 100).toFixed(1) + '%' : '-',
  delta: (n) => n ? parseFloat(n).toFixed(3) : '-',
};

// Helper to deduce Expiry Date from Symbol
// Symbol format: C-BTC-Strike-Date (e.g., C-BTC-62000-290526 -> 29 May 2026)
// Or use the 'settlement_time' or similar field if available.
// Based on user provided data: "symbol":"C-BTC-62000-290526"
// The last part is DDMMYY
function parseDateFromSymbol(symbol) {
  const parts = symbol.split('-');
  const dateStr = parts[parts.length - 1]; // "290526"
  if (!dateStr || dateStr.length !== 6) return 'Unknown';
  const day = dateStr.slice(0, 2);
  const month = dateStr.slice(2, 4);
  const year = '20' + dateStr.slice(4, 6);
  return `${year}-${month}-${day}`;
}

// Styles
const S = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    width: '100%',
    background: '#0d1117',
    color: '#d0d7de',
    overflow: 'hidden',
    fontSize: '12px',
    fontFamily: 'JetBrains Mono, monospace'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '8px 12px',
    borderBottom: '1px solid #30363d',
    background: '#161b22',
    color: '#e6edf3'
  },
  title: {
    fontWeight: 'bold',
    fontSize: '14px',
    color: '#ffffff'
  },
  select: {
    background: '#0d1117',
    border: '1px solid #30363d',
    borderRadius: '6px',
    padding: '4px 8px',
    color: '#e6edf3',
    outline: 'none',
    fontSize: '12px'
  },
  expiryScroll: {
    display: 'flex',
    gap: '8px',
    overflowX: 'auto',
    alignItems: 'center',
    paddingBottom: '2px'
  },
  expiryBtn: (isActive) => ({
    padding: '4px 10px',
    borderRadius: '6px',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transition: 'all 0.2s',
    border: 'none',
    fontSize: '11px',
    background: isActive ? '#1f6feb' : '#21262d',
    color: isActive ? '#ffffff' : '#8b949e',
    fontWeight: isActive ? '600' : '400',
    boxShadow: isActive ? '0 0 8px rgba(31,111,235,0.4)' : 'none'
  }),
  tableHeader: {
    display: 'grid',
    gridTemplateColumns: 'minmax(300px, 1fr) 80px minmax(300px, 1fr)',
    background: '#161b22',
    borderBottom: '1px solid #30363d',
    fontSize: '11px',
    fontWeight: '600',
    color: '#8b949e',
    textTransform: 'uppercase',
    letterSpacing: '0.05em'
  },
  columnGroup: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    textAlign: 'center',
    alignItems: 'center',
    padding: '6px 0'
  },
  strikeHeader: {
    textAlign: 'center',
    padding: '6px 0',
    background: '#21262d',
    color: '#ffffff',
    borderLeft: '1px solid #30363d',
    borderRight: '1px solid #30363d'
  },
  tableBody: {
    flex: 1,
    overflowY: 'auto',
    background: '#0d1117'
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(300px, 1fr) 80px minmax(300px, 1fr)',
    borderBottom: '1px solid rgba(48, 54, 61, 0.4)',
    cursor: 'default',
    transition: 'background 0.1s'
  },
  cellGroupCall: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    textAlign: 'center',
    alignItems: 'center',
    padding: '4px 0',
    borderRight: '1px solid rgba(48, 54, 61, 0.4)'
  },
  cellGroupPut: {
    display: 'grid',
    gridTemplateColumns: 'repeat(5, 1fr)',
    textAlign: 'center',
    alignItems: 'center',
    padding: '4px 0',
    borderLeft: '1px solid rgba(48, 54, 61, 0.4)'
  },
  strikeCell: {
    background: '#161b22',
    color: '#e6edf3',
    fontWeight: '600',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderLeft: '1px solid #30363d',
    borderRight: '1px solid #30363d'
  },
  // Text Colors
  textCall: '#3fb950', // green
  textPut: '#f85149',  // red
  textDim: '#6e7681',
  textWarn: '#d29922', // yellow/gold for IV
  rowHover: '#161b22'
};

export default function OptionChain() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [selectedAsset, setSelectedAsset] = useState('BTC');

  // Hover state for row highlighting
  const [hoverRow, setHoverRow] = useState(null);

  // Fetch data on mount
  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        // Using the endpoint discovered:
        const response = await fetch('https://api.india.delta.exchange/v2/tickers?contract_types=call_options,put_options');
        const json = await response.json();
        
        if (json.success && Array.isArray(json.result)) {
          setData(json.result);
        } else {
          setError('Failed to fetch option data');
        }
      } catch (err) {
        console.error(err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  // Process data for the view
  const processed = useMemo(() => {
    if (!data.length) return { expiries: [], chain: [] };

    // 1. Filter by Asset
    const assetData = data.filter(d => d.underlying_asset_symbol === selectedAsset);

    // 2. Extract Expiries
    const expirySet = new Set();
    assetData.forEach(d => {
      const date = parseDateFromSymbol(d.symbol);
      expirySet.add(date);
    });
    const expiries = Array.from(expirySet).sort();

    // Default expiry selection if none selected
    let currentExpiry = selectedExpiry;
    if (!currentExpiry && expiries.length > 0) {
      currentExpiry = expiries[0];
       // We can't setState inside render/memo, but we can return it to be used.
       // Ideally we use a separate useEffect for this, but for now we'll handle it in the filter.
    }
    
    const activeExpiry = currentExpiry || expiries[0];

    // 3. Build Chain for Active Expiry
    // Map: Strike -> { call: ..., put: ... }
    const strikesMap = new Map();

    assetData.forEach(d => {
      const date = parseDateFromSymbol(d.symbol);
      if (date !== activeExpiry) return;

      const strike = parseFloat(d.strike_price);
      if (!strikesMap.has(strike)) {
        strikesMap.set(strike, { strike, call: null, put: null });
      }

      const type = d.contract_type === 'call_options' ? 'call' : 'put';
      strikesMap.get(strike)[type] = d;
    });

    const chain = Array.from(strikesMap.values()).sort((a, b) => a.strike - b.strike);

    return { expiries, chain, activeExpiry };

  }, [data, selectedExpiry, selectedAsset]);

  useEffect(() => {
    if (!selectedExpiry && processed.expiries.length > 0) {
      setSelectedExpiry(processed.expiries[0]);
    }
  }, [processed.expiries, selectedExpiry]);

  if (loading) return (
    <div style={{ ...S.container, justifyContent:'center', alignItems:'center', color:'#8b949e' }}>
      Loading Option Chain...
    </div>
  );
  
  if (error) return (
    <div style={{ ...S.container, justifyContent:'center', alignItems:'center', color:'#f85149' }}>
      Error: {error}
    </div>
  );

  return (
    <div style={S.container}>
      {/* Controls Header */}
      <div style={S.header}>
        <div style={S.title}>Option Chain</div>
        
        {/* Asset Selector */}
        <select 
          value={selectedAsset} 
          onChange={e => setSelectedAsset(e.target.value)}
          style={S.select}
        >
          <option value="BTC">BTC</option>
          <option value="ETH">ETH</option>
        </select>

        {/* Expiry Selector */}
        <div style={S.expiryScroll} className="no-scrollbar">
          {processed.expiries.map(date => (
            <button
              key={date}
              onClick={() => setSelectedExpiry(date)}
              style={S.expiryBtn(selectedExpiry === date)}
            >
              {date}
            </button>
          ))}
        </div>
      </div>

      {/* Table Header */}
      <div style={S.tableHeader}>
        {/* CALLS Header */}
        <div style={S.columnGroup}>
          <div className="hidden md:block">Delta</div>
          <div className="hidden sm:block">IV</div>
          <div>Bid</div>
          <div>Ask</div>
          <div className="hidden lg:block">OI</div>
        </div>

        {/* STRIKE Header */}
        <div style={S.strikeHeader}>Strike</div>

        {/* PUTS Header */}
        <div style={S.columnGroup}>
            <div>Bid</div>
            <div>Ask</div>
            <div className="hidden sm:block">IV</div>
            <div className="hidden md:block">Delta</div>
            <div className="hidden lg:block">OI</div>
        </div>
      </div>

      {/* Chain Table Body */}
      <div style={S.tableBody} className="custom-scrollbar">
        {processed.chain.map((row) => {
          const call = row.call || {};
          const put = row.put || {};
          const callGreeks = call.greeks || {};
          const putGreeks = put.greeks || {};
          const callQuotes = call.quotes || {};
          const putQuotes = put.quotes || {};

          const isHover = hoverRow === row.strike;

          return (
            <div 
              key={row.strike} 
              style={{ ...S.row, background: isHover ? S.rowHover : 'transparent' }}
              onMouseEnter={() => setHoverRow(row.strike)}
              onMouseLeave={() => setHoverRow(null)}
            >
              
              {/* CALLS Data */}
              <div style={{ ...S.cellGroupCall, color: call.symbol ? S.textCall : S.textDim }}>
                <div style={{ color: S.textDim }} className="hidden md:block">{format.delta(callGreeks.delta)}</div>
                <div style={{ color: S.textWarn }} className="hidden sm:block">{format.iv(callQuotes.mark_iv)}</div>
                <div style={{ fontFamily:'monospace' }}>{callQuotes.best_bid || '-'}</div>
                <div style={{ fontFamily:'monospace' }}>{callQuotes.best_ask || '-'}</div>
                <div style={{ color: S.textDim }} className="hidden lg:block">{call.oi_contracts || '-'}</div>
              </div>

              {/* STRIKE Price */}
              <div style={{ ...S.strikeCell, background: isHover ? '#30363d' : '#161b22' }}>
                {row.strike.toLocaleString()}
              </div>

              {/* PUTS Data */}
              <div style={{ ...S.cellGroupPut, color: put.symbol ? S.textPut : S.textDim }}>
                <div style={{ fontFamily:'monospace' }}>{putQuotes.best_bid || '-'}</div>
                <div style={{ fontFamily:'monospace' }}>{putQuotes.best_ask || '-'}</div>
                <div style={{ color: S.textWarn }} className="hidden sm:block">{format.iv(putQuotes.mark_iv)}</div>
                <div style={{ color: S.textDim }} className="hidden md:block">{format.delta(putGreeks.delta)}</div>
                <div style={{ color: S.textDim }} className="hidden lg:block">{put.oi_contracts || '-'}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
