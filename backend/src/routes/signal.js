// backend/src/routes/signal.js
import express from 'express';
import { computeSignal } from '../services/signalService.js';

const router = express.Router();

// POST /api/signals/compute
// Receives market data and returns a trading signal.
router.post('/compute', (req, res) => {
  try {
    const { candles, markPrice, trades, orderBook } = req.body;

    if (!candles || !markPrice) {
      return res.status(400).json({ error: 'Missing required market data: candles and markPrice are required.' });
    }

    const result = computeSignal({ candles, markPrice, trades, orderBook });

    if (result) {
      res.json(result);
    } else {
      res.status(204).send(); // No content, signal could not be computed
    }
  } catch (error) {
    console.error('Error computing signal:', error);
    res.status(500).json({ error: 'An internal server error occurred while computing the signal.' });
  }
});

export default router;
