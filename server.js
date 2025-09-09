require('dotenv').config();
const path = require("path");
const express = require("express");
const app = require('./app');   // should already export an express() instance
const bot = require('./controller/tradeController');
const { getLogs } = require("./logger");

// ===== Logs API =====
app.get("/api/logs", (req, res) => {
  res.json({ logs: getLogs() });
});

// ===== PnL API =====
// ===== PnL API =====
app.get("/api/pnl", async (req, res) => {
  try {
    const symbol = req.query.symbol || "BTCUSDT"; 

    if (typeof bot.getPositionInfo !== "function") {
      return res.status(500).json({ error: "getPositionInfo not available" });
    }

    const position = await bot.getPositionInfo(symbol);

    if (!position) {
      return res.json({ symbol, position: null });
    }

    res.json({
      symbol,
      side: position.side,                  // LONG or SHORT
      size: position.size,                  // Position size
      entryPrice: position.entryPrice,      // Avg entry
      markPrice: position.markPrice,        // Current market price
      leverage: position.leverage,          // Applied leverage
      unrealizedPnl: position.unrealizedPnl // Current PnL
    });

  } catch (err) {
    console.error("❌ /api/pnl error:", err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ===== Serve static frontend =====
app.use(express.static(path.join(__dirname, "public")));

// ===== Root Route =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "bro.html"));
});
// ===== Strategy API =====
app.post("/api/strategy", async (req, res) => {
  try {
    const symbol = req.body.symbol || "BTCUSDT";
    const candles = await bot.getHistoricalCandles(symbol, "1", 50);
    const signal = await bot.generateSignal(candles, symbol);

    if (!signal) {
      return res.json({ action: "Hold" });
    }

    // 🔑 Extra safety: if signal is just a string ("Buy"/"Sell")
    if (typeof signal === "string") {
      return res.json({ action: signal });
    }

    // Otherwise assume it's an object like { action: "Buy", rsi: 70, ... }
    res.json({
      action: signal.action || "Hold",
      ...signal
    });

  } catch (err) {
    console.error("Strategy error:", err.message);
    res.status(500).json({ error: "Strategy failed" });
  }
});


const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  // ===== Auto start trading monitor =====
  if (typeof bot.startLoop === 'function') {
    console.log("🤖 Starting trading monitor...");
    bot.startLoop();
  } else {
    console.error('❌ startLoop is not exported from tradeController');
  }
});
