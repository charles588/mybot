const express = require('express');
const router = express.Router();

const {
  getHistoricalCandles,
  getCandles,
  generateSignal,
  executeTrade
} = require('../controller/tradeController');

// GET /trade/candle?symbol=XRPUSDT
router.get('/candle', async (req, res) => {
  try {
    const { symbol } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

    const candles = await getHistoricalCandles(symbol, '1', 200);
    if (!candles || candles.length === 0) {
      return res.status(400).json({ error: 'No candles fetched' });
    }
    res.json({ candles });
  } catch (err) {
    console.error('API /candle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /trade/strategy { symbol }
router.post('/strategy', async (req, res) => {
  try {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'Symbol is required' });

    const candles = await getCandles(symbol, '1', 200);
    const signal = generateSignal(candles);
    res.json({ signal });
  } catch (err) {
    console.error('Strategy Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /trade/trade { side, symbol, qty, tp, sl }
router.post('/trade', async (req, res) => {
  try {
    const { side, symbol, qty, tp, sl } = req.body;
    if (!side || !symbol || !qty) {
      return res.status(400).json({ error: 'side, symbol, and qty are required' });
    }
    const result = await executeTrade({
      side,
      symbol,
      qty,
      stopLoss: sl,
      takeProfit: tp
    });
    if (!result) return res.status(500).json({ error: 'No response from executeTrade' });
    if (result.error) return res.status(500).json({ error: result.error });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('❌ Trade route error:', err.response?.data || err.message || err);
    res.status(500).json({ error: err.message || 'Unknown error' });
  }
});

module.exports = router;
