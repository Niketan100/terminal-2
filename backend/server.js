import express from 'express';
import cors from 'cors';
import signalRoutes from './src/routes/signal.js';

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' })); // Increase payload limit for candle data

// API Routes
app.use('/api/signals', signalRoutes);

// Simple root endpoint for health check
app.get('/', (req, res) => {
  res.send('NiKEta Terminal Backend is running.');
});

app.listen(PORT, () => {
  console.log(`Backend server is listening on port ${PORT}`);
});
