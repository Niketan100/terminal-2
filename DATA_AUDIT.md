# NiKEta Terminal — Data Audit & Available Assets

## Current Data Source
- **API**: Delta Exchange (https://api.india.delta.exchange)
- **WebSocket**: wss://socket.india.delta.exchange
- **Default Symbol**: BTCUSD (Bitcoin perpetual futures)

## Data Received for Current Symbol (BTCUSD)

### 1. **Ticker Data** (`v2/ticker`)
- `mark_price`: Current mark price
- `close`: Last trade price
- `open`: Day open price
- `high`: Day high
- `low`: Day low
- `oi_value_usd`: Open Interest in USD
- `volume`: 24h volume
- `last_price`: Last trade price
- `symbol`: Trading pair (e.g., BTCUSD)

### 2. **Candlestick Data** (`candlestick_1m`, `candlestick_5m`)
- `time`: Unix timestamp (seconds)
- `open`: Candle open price
- `high`: Candle high price
- `low`: Candle low price
- `close`: Candle close price
- `volume`: Candle volume
- **Computed fields**:
  - `bv`: Buy volume
  - `sv`: Sell volume

### 3. **Trade Data** (`all_trades`)
- `price`: Trade price
- `size`: Trade size (quantity)
- `side`: Buy/Sell
- `buyer_role`: Taker role
- `timestamp`: Trade time

### 4. **Order Book Data** (`l2_orderbook`)
- `bids`: Array of [price, size] pairs (buy orders)
- `asks`: Array of [price, size] pairs (sell orders)

### 5. **Funding Rate** (`funding_rate`)
- `funding_rate`: Current 8-hour funding rate
- `symbol`: Trading pair

### 6. **Mark Price** (`mark_price`)
- `price`: Mark price (for perpetuals)
- `symbol`: Trading pair

## Available Trading Symbols (Perpetuals)
Delta Exchange likely supports:
- **BTCUSD**: Bitcoin (current)
- **ETHUSD**: Ethereum
- **LINKUSD**: Chainlink
- **BNBUSD**: Binance Coin
- **XRPUSD**: Ripple
- **ADAUSD**: Cardano
- And more...

## Next Steps
1. Add **symbol switcher UI** to Terminal
2. Modify `useDeltaWS.js` to accept dynamic symbol
3. Update all chart rendering to handle symbol changes
4. Create a **symbol list** component showing all available assets
5. Allow users to chart **multiple assets** side-by-side (optional)

## Usage
To add a new symbol:
1. Pass symbol name to `useDeltaWS()` hook
2. Subscribe to new symbol channels in WebSocket
3. Update chart title/labels
4. Reload candle history
