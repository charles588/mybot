require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const { addTradeLog } = require("../logger");
const BASE_URL = 'https://api.bybit.com';

// ===== ENV =====
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
if (!API_KEY || !API_SECRET) {
  throw new Error('Missing API_KEY or API_SECRET in environment');
}

// ===== STRATEGY CONFIG =====
const SYMBOL = 'ETHUSDT';
const ENTRY_INTERVAL = '1';
const TREND_INTERVAL = '5';

const LEVERAGE_TO_USE = 150;

const RISK_PER_TRADE = 0.5;     // percent of wallet
const ATR_PERIOD = 14;
const MIN_ATR_USDT = 0.0015;

const KC_EMA = 20;
const KC_ATR_MULT = 1.5;
const SL_ATR_MULT = 1;
const TP_ATR_MULT = 1.8;
const minQtyCache = {};

// ===== BOT STATE =====
let lastTradeTime = 0;
const tradeCooldown = 60 * 1000;
async function getMinQty(symbol) {
    // If already fetched, return cached
    if (minQtyCache[symbol]) {
        return minQtyCache[symbol];
    }

    try {
        const res = await axios.get(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${symbol}`);
        const info = res.data.result.list[0];

        if (info && info.lotSizeFilter && info.lotSizeFilter.minOrderQty) {
            const minQty = parseFloat(info.lotSizeFilter.minOrderQty);
            minQtyCache[symbol] = minQty; // Save to cache
            return minQty;
        }
        return 0;
    } catch (err) {
        console.error("getMinQty error:", err.message);
        return 0;
    }
}
// ===== UTILS =====
function hmacSha256(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function normalizeSide(side) {
  const s = String(side || '').toUpperCase();
  if (s === 'BUY') return 'Buy';
  if (s === 'SELL') return 'Sell';
  throw new Error(`Invalid side: ${side}`);
}

function decimalsFromStep(stepStr) {
  const s = String(stepStr);
  const i = s.indexOf('.');
  return i === -1 ? 0 : (s.length - i - 1);
}
function roundStep(value, step) {
  const v = Number(value);
  const st = Number(step);
  if (!isFinite(v) || !isFinite(st) || st <= 0) return value;
  const r = Math.round(v / st) * st;
  const d = decimalsFromStep(step);
  return Number(r.toFixed(d));
}

// ===== EXCHANGE META =====
const instrumentCache = new Map();

async function getInstrumentMeta(symbol) {
  if (instrumentCache.has(symbol)) return instrumentCache.get(symbol);
  const { data } = await axios.get(`${BASE_URL}/v5/market/instruments-info`, {
    params: { category: 'linear', symbol },
    timeout: 10_000
  });
  const info = data?.result?.list?.[0];
  if (!info) throw new Error(`Instrument meta not found for ${symbol}`);
  const lot = info.lotSizeFilter || {};
  const price = info.priceFilter || {};
  const meta = {
    tickSize: Number(price.tickSize || '0.0001'),
    minOrderQty: Number(lot.minOrderQty || '1'),
    qtyStep: Number(lot.qtyStep || '1')
  };
  instrumentCache.set(symbol, meta);
  return meta;
}

function adjustQtyPrecisionWithMeta(qty, meta) {
  let q = Math.max(Number(qty), meta.minOrderQty);
  q = roundStep(q, meta.qtyStep);
  return q;
}
function roundPriceWithMeta(price, meta) {
  return roundStep(price, meta.tickSize);
}

// ===== MARKET DATA =====
async function getCandles(symbol, interval = '1', limit = 300) {
  try {
    const { data } = await axios.get(`${BASE_URL}/v5/market/kline`, {
      params: { category: 'linear', symbol, interval, limit },
      timeout: 10_000
    });
    const list = data?.result?.list || [];
    const candles = list.map(k => ({
      time: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5])
    }));
    candles.sort((a, b) => a.time - b.time);
    return candles;
  } catch (e) {
    console.error('getCandles error', e.response?.data || e.message);
    return [];
  }
}

// Alias for routes that expect this name
async function getHistoricalCandles(symbol, interval = '1', limit = 200) {
  return getCandles(symbol, interval, limit);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const TR = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    TR.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  // Wilder smoothing
  let atr = TR.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < TR.length; i++) {
    atr = (atr * (period - 1) + TR[i]) / period;
  }
  return atr;
}

function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const series = [e];
  for (let i = period; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
    series.push(e);
  }
  return series;
}

// ===== Dynamic TP & SL =====
function randomRange(min, max) {
  return min + Math.random() * (max - min);
}


// ===== ACCOUNT =====
async function getUSDTBalance() {
  try {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const accountType = 'UNIFIED';

    const queryString = `accountType=${accountType}`;
    const sign = hmacSha256(API_SECRET, `${timestamp}${API_KEY}${recvWindow}${queryString}`);

    const { data } = await axios.get(`${BASE_URL}/v5/account/wallet-balance?${queryString}`, {
      headers: {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': sign,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': String(timestamp),
        'X-BAPI-RECV-WINDOW': String(recvWindow),
      },
      timeout: 10_000
    });

   addTradeLog ('💰 Balance API response:', data); // optional for debugging

    // ✅ REPLACED LINES:
    const coins = data?.result?.list?.[0]?.coin || [];
    const usdt = coins.find(c => c.coin === 'USDT');
    return parseFloat(usdt?.walletBalance || '0'); // <-- use walletBalance

  } catch (e) {
    console.error('getUSDTBalance error:', e.response?.data || e.message);
    return 0;
  }
}
// size by risk (fetches balance internally)
async function computeQtyByRisk(balance, entryPrice, stopLossPrice, riskPercent, symbol) {
    const riskAmount = balance * (riskPercent / 100);
    const riskPerUnit = Math.abs(entryPrice - stopLossPrice);

    if (riskPerUnit === 0) {
    addTradeLog("⚠️ Risk per unit is 0, defaulting to minQty");
    const minQty = await getMinQty(symbol);
    return minQty;
}

    let qty = riskAmount / riskPerUnit;

    // Get min qty from cache or API
    const minQty = await getMinQty(symbol);

    if (qty < minQty) {
       addTradeLog(`⚠️ Qty (${qty}) too small; adjusting to min (${minQty})`);
        qty = minQty;
    }

    return parseFloat(qty.toFixed(3)); // Ensure proper decimal places
}
function getSignature(timestamp, apiKey, apiSecret, body) {
  const paramStr = timestamp + apiKey + "5000" + JSON.stringify(body);
  return crypto
    .createHmac("sha256", apiSecret)
    .update(paramStr)
    .digest("hex");
}
// ===== LEVERAGE =====
async function setLeverage(symbol, leverage = 150) {
  try {
    const timestamp = Date.now();
    const recvWindow = 5000;

    const bodyObj = {
      category: 'linear',
      symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage)
    };

    const rawBody = JSON.stringify(bodyObj);
    const signature = hmacSha256(API_SECRET, `${timestamp}${API_KEY}${recvWindow}${rawBody}`);

    const headers = {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': API_KEY,
      'X-BAPI-SIGN': signature,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': String(timestamp),
      'X-BAPI-RECV-WINDOW': String(recvWindow)
    };

    const { data } = await axios.post(`${BASE_URL}/v5/position/set-leverage`, rawBody, { headers, timeout: 10_000 });
    if (data.retCode === 0) {
      addTradeLog(`✅ Leverage set to ${leverage}x for ${symbol}`);
      return true;
    }
    console.warn(`⚠️ setLeverage (${data.retCode}): ${data.retMsg}`);
    return false;
  } catch (err) {
    console.error('❌ setLeverage error:', err.response?.data || err.message);
    return false;
  }
}

// ===== VWAP =====
function calcVWAP(candles) {
  if (!candles || candles.length === 0) return null;
  let pv = 0; // price * volume
  let vol = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    pv += typicalPrice * c.volume;
    vol += c.volume;
  }
  return vol > 0 ? pv / vol : null;
}
async function getPnL(req, res) {
  try {
    const { symbol } = req.query; // e.g. BTCUSDT
    const response = await axios.get(`${BASE_URL}/v5/position/list`, {
      params: { category: "linear", symbol },
      headers: { "X-BAPI-API-KEY": API_KEY } // add proper auth headers
    });

    const position = response.data.result.list[0]; // first position
    if (!position) {
      return res.json({ profit: 0, loss: 0, pnl: 0 });
    }

    const pnl = parseFloat(position.unrealisedPnl);
    res.json({
      profit: pnl > 0 ? pnl : 0,
      loss: pnl < 0 ? pnl : 0,
      pnl
    });
  } catch (err) {
    console.error("Error fetching PnL:", err.message);
    res.status(500).json({ error: "Failed to fetch PnL" });
  }
}

module.exports = { getPnL };

// ===== ORDER BOOK IMBALANCE =====
async function getOrderBookImbalance(symbol, depth = 20) {
  try {
    const { data } = await axios.get(`${BASE_URL}/v5/market/orderbook`, {
      params: { category: "linear", symbol, limit: depth },
      timeout: 5000
    });

    const bids = data?.result?.b || []; // [price, size]
    const asks = data?.result?.a || [];

    const bidVol = bids.reduce((sum, [p, s]) => sum + parseFloat(s), 0);
    const askVol = asks.reduce((sum, [p, s]) => sum + parseFloat(s), 0);

    const imbalance = (bidVol - askVol) / (bidVol + askVol || 1);

    return imbalance; // -1 = sell pressure, +1 = buy pressure
  } catch (err) {
    console.error("getOrderBookImbalance error:", err.message);
    return 0;
  }
}

// ===== SIGNAL (Keltner/EMA/ATR) =====
async function generateSignal(candles, symbol) {
  if (candles.length < 30) return null;

  // ---- EMA 9 and 21 ----
  const closes = candles.map(c => parseFloat(c.close));
  const ema9 = emaSeries(closes, 9);
  const ema21 = emaSeries(closes, 21);

  const ema9Prev = ema9[ema9.length - 2];
  const ema21Prev = ema21[ema21.length - 2];
  const ema9Curr = ema9[ema9.length - 1];
  const ema21Curr = ema21[ema21.length - 1];

  // ---- VWAP ----
  const vwap = calcVWAP(candles);
  const lastClose = closes[closes.length - 1];

  // ---- Order Book Imbalance ----
  const obi = await getOrderBookImbalance(symbol); // -1 to +1

  // ---- Volume Spike ----
  const volumes = candles.map(c => parseFloat(c.volume));
  const lastVol = volumes[volumes.length - 1];
  const avgVol = volumes.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
const volumeSpike = lastVol > avgVol * 0.8; 
addTradeLog({
  ema9Prev, ema21Prev, ema9Curr, ema21Curr,
  lastClose, vwap,
  obi,
  lastVol, avgVol,
  volumeSpike
});
  // === ENTRY CONDITIONS ===
  // LONG
  if (
    ema9Prev < ema21Prev && ema9Curr > ema21Curr && // EMA cross up
    lastClose > vwap && 
    obi > 0.1 && // >55% buy pressure
    volumeSpike
  ) {
    const tpPercent = randomRange(0.008, 0.015); // 0.2–0.4%
    const slPercent = randomRange(0.004, 0.005); // 0.1–0.3%

    return {
      action: "Buy",
      entryPrice: lastClose,
      stopLoss: lastClose * (1 - slPercent),
      takeProfit: lastClose * (1 + tpPercent),
      confidence: 1 + obi
    };
  }

  // SHORT
  if (
    ema9Prev > ema21Prev && ema9Curr < ema21Curr && // EMA cross down
    lastClose < vwap && 
    obi < -0.1 && // >55% sell pressure
    volumeSpike
  ) {
    const tpPercent = randomRange(0.002, 0.004);
    const slPercent = randomRange(0.001, 0.003);

    return {
      action: "Sell",
      entryPrice: lastClose,
      stopLoss: lastClose * (1 + slPercent),
      takeProfit: lastClose * (1 - tpPercent),
      confidence: 1 - obi
    };
  }
  const atr = calcATR(candles, ATR_PERIOD);
if (atr < MIN_ATR_USDT) {
  addTradeLog("⚠️ ATR too low, skipping trade");
   return { action: "Hold" };
}


   return { action: "Hold" };
}
// ===== ORDERING =====
async function executeTrade({ side, symbol, qty, stopLoss, takeProfit }) {
  try {
    const meta = await getInstrumentMeta(symbol);
    const bybitSide = normalizeSide(side);
    const finalQty = adjustQtyPrecisionWithMeta(qty, meta);

    const order = {
      category: 'linear',
      symbol,
      side: bybitSide,
      orderType: 'Market',
      qty: String(finalQty),
      timeInForce: 'IOC',
      takeProfit: String(roundPriceWithMeta(takeProfit, meta)),
      stopLoss: String(roundPriceWithMeta(stopLoss, meta)),
      reduceOnly: false
    };

    const timestamp = Date.now();
    const body = JSON.stringify(order);
    const sign = hmacSha256(API_SECRET, `${timestamp}${API_KEY}5000${body}`);

   addTradeLog('📤 Sending order payload:', order);

    const response = await axios.post(`${BASE_URL}/v5/order/create`, body, {
      headers: {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': sign,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': String(timestamp),
        'X-BAPI-RECV-WINDOW': '5000',
        'Content-Type': 'application/json'
      },
      timeout: 10_000
    });

   addTradeLog('✅ Order placed:', response.data);
    return response.data;
  } catch (err) {
    console.error('❌ Error placing order:', err.response?.data || err.message);
    return { error: err.response?.data || err.message };
  }
}

async function updateStopLoss(symbol, newStopLoss) {
  try {
    const timestamp = Date.now();
    const recvWindow = 5000;

    const bodyObj = {
      category: "linear",
      symbol,
      stopLoss: String(newStopLoss)
    };

    const body = JSON.stringify(bodyObj);
    const sign = hmacSha256(API_SECRET, `${timestamp}${API_KEY}${recvWindow}${body}`);

    addTradeLog(`🔄 Updating Stop Loss for ${symbol} → ${newStopLoss}`);

    await axios.post(`${BASE_URL}/v5/position/trading-stop`, body, {
      headers: {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': sign,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': String(timestamp),
        'X-BAPI-RECV-WINDOW': String(recvWindow),
        'Content-Type': 'application/json'
      }
    });

  } catch (err) {
    console.error("❌ Error updating Stop Loss:", err.response?.data || err.message);
  }
}
async function monitorReversal(symbol, side, entryPrice) {
  let trailStop = side === "Buy"
    ? entryPrice * 0.997 // 0.3% below entry
    : entryPrice * 1.003; // 0.3% above entry

  const interval = setInterval(async () => {
   const candles = await getCandles(symbol, "1", 50);

// remove the still-forming last candle
candles.pop();

const closes = candles.map(c => c.close);

// calculate EMAs on fully closed candles only
const ema9 = ema(closes, 9);
const ema21 = ema(closes, 21);
    const lastClose = closes[closes.length - 1];

    // 📉 EMA reversal exit
    if ((side === "Buy" && ema9 < ema21) || (side === "Sell" && ema9 > ema21)) {
     addTradeLog("⚠️ EMA reversal detected, closing trade.");
      await closePosition(symbol);
      clearInterval(interval);
      return;
    }

    // 📈 Trailing Stop logic
    if (side === "Buy" && lastClose > entryPrice * 1.002) {
      const newStop = lastClose * 0.998;
      if (newStop > trailStop) {
        trailStop = newStop;
        await updateStopLoss(symbol, trailStop);
      }
    } else if (side === "Sell" && lastClose < entryPrice * 0.998) {
      const newStop = lastClose * 1.002;
      if (newStop < trailStop) {
        trailStop = newStop;
        await updateStopLoss(symbol, trailStop);
      }
    }
 }, 60000);
}
async function hasOpenPosition(symbol) {
  const timestamp = Date.now();
  const recvWindow = 5000;
  const queryString = `category=linear&symbol=${symbol}`;
  const sign = hmacSha256(API_SECRET, `${timestamp}${API_KEY}${recvWindow}${queryString}`);

  const { data } = await axios.get(`${BASE_URL}/v5/position/list?${queryString}`, {
    headers: {
      'X-BAPI-API-KEY': API_KEY,
      'X-BAPI-SIGN': sign,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': String(timestamp),
      'X-BAPI-RECV-WINDOW': String(recvWindow),
    }
  });

  const pos = data?.result?.list?.[0];
  return pos && parseFloat(pos.size) > 0;
}
async function getPosition(symbol) {
  const timestamp = Date.now();
  const recvWindow = 5000;
  const queryString = `category=linear&symbol=${symbol}`;
  const sign = hmacSha256(API_SECRET, `${timestamp}${API_KEY}${recvWindow}${queryString}`);

  const { data } = await axios.get(`${BASE_URL}/v5/position/list?${queryString}`, {
    headers: {
      'X-BAPI-API-KEY': API_KEY,
      'X-BAPI-SIGN': sign,
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-TIMESTAMP': String(timestamp),
      'X-BAPI-RECV-WINDOW': String(recvWindow),
    }
  });

  return data?.result?.list?.[0] || null;
}

async function getPositionSide(symbol) {
  const pos = await getPosition(symbol);
  return pos && parseFloat(pos.size) > 0 ? pos.side : null;
}

async function getPositionQty(symbol) {
  const pos = await getPosition(symbol);
  return pos ? parseFloat(pos.size) : 0;
}
// ===== BOT LOOP =====

async function runBot() {
    const symbol = SYMBOL; // ensures it's always available

    if (Date.now() - lastTradeTime < tradeCooldown) {
       addTradeLog("⏳ Cooldown active; skipping...");
        return;
    }

    addTradeLog(`\n=== Running bot for ${symbol} ===`);

    try {
        const candles = await getHistoricalCandles(symbol, ENTRY_INTERVAL, 50);
        if (!candles || candles.length < 50) {
            addTradeLog("⚠️ Not enough candles yet");
            return;
        }

    const signal = await generateSignal(candles, symbol);
   if (!signal || signal.action.toUpperCase() === "HOLD") {
   addTradeLog("⏸ No trade signal this time.");
    return;
}
const alreadyInTrade = await hasOpenPosition(symbol);
if (alreadyInTrade) {
 addTradeLog("🚫 Already in an open position, skipping new trade.");
  return;
}
    const balance = await getUSDTBalance();
if (typeof balance !== 'number' || isNaN(balance) || balance <= 0) {
    addTradeLog("⚠️ Could not fetch balance; skipping.");
    return;
}
        

let qty = await computeQtyByRisk(
  balance,
  signal.entryPrice,
  signal.stopLoss,
  RISK_PER_TRADE,
  symbol
);

// Confidence boost from OBI
if (signal.confidence && signal.confidence > 1) {
  qty *= signal.confidence;
addTradeLog(`⚡ Confidence boost applied (OBI): qty x${signal.confidence}`);
}

if (qty <= 0) {
 addTradeLog("⚠️ Qty <= 0, retrying with minQty…");
  qty = await getMinQty(symbol);
}

await executeTrade({
  side: signal.action,
  symbol,
  qty,
  stopLoss: signal.stopLoss,
  takeProfit: signal.takeProfit
});
await monitorReversal(symbol, signal.action, candles[candles.length - 1].close);
/*  // Exit after 3 minutes if not in profit
setTimeout(async () => {
  const pnl = await getUnrealizedPnL(SYMBOL);
  if (pnl <= 0) {
    addTradeLog("⏳ Exiting position after 3 min (no profit)");
    await closePosition(SYMBOL);
  }
}, 3 * 60 * 1000);*/

        lastTradeTime = Date.now();

    } catch (err) {
        console.error(`❌ runBot error: ${err.message}`);
    }
}
async function getUnrealizedPnL(symbol) {
  try {
    const timestamp = Date.now();
    const recvWindow = 5000;
    const queryString = `category=linear&symbol=${symbol}`;
    const sign = hmacSha256(API_SECRET, `${timestamp}${API_KEY}${recvWindow}${queryString}`);

    const { data } = await axios.get(`${BASE_URL}/v5/position/list?${queryString}`, {
      headers: {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': sign,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': String(timestamp),
        'X-BAPI-RECV-WINDOW': String(recvWindow),
      },
      timeout: 10_000
    });

    const pos = data?.result?.list?.[0];
    return pos ? parseFloat(pos.unrealisedPnl) : 0;
  } catch (err) {
    console.error("getUnrealizedPnL error:", err.message);
    return 0;
  }
}
async function getPositionInfo(symbol) {
  try {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const query = `category=linear&symbol=${symbol}`;

    const sign = crypto
      .createHmac("sha256", process.env.API_SECRET)
      .update(timestamp + process.env.API_KEY + recvWindow + query)
      .digest("hex");

    const headers = {
      "X-BAPI-API-KEY": process.env.API_KEY,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-SIGN": sign,
      "X-BAPI-RECV-WINDOW": recvWindow
    };

    const url = `${BASE_URL}/v5/position/list?${query}`;
    const res = await axios.get(url, { headers });

    const pos = res.data.result.list[0];
    if (!pos) return null;

    return {
      side: pos.side,
      size: pos.size,
      entryPrice: pos.avgPrice,
      markPrice: pos.markPrice,
      leverage: pos.leverage,
      unrealizedPnl: pos.unrealisedPnl
    };
  } catch (err) {
    console.error("❌ getPositionInfo error:", err.response?.data || err.message);
    throw err;
  }
}

async function closePosition(symbol) {
  try {
    const timestamp = Date.now();
    const recvWindow = 5000;

    const queryString = `category=linear&symbol=${symbol}`;
    const sign = hmacSha256(API_SECRET, `${timestamp}${API_KEY}${recvWindow}${queryString}`);

    const { data } = await axios.get(`${BASE_URL}/v5/position/list?${queryString}`, {
      headers: {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': sign,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': String(timestamp),
        'X-BAPI-RECV-WINDOW': String(recvWindow),
      }
    });

    const pos = data?.result?.list?.[0];
    if (!pos || parseFloat(pos.size) === 0) {
   addTradeLog("ℹ️ No open position to close");
      return;
    }

    const side = pos.side === "Buy" ? "Sell" : "Buy"; // opposite order to close
    const order = {
      category: "linear",
      symbol,
      side,
      orderType: "Market",
      qty: pos.size,
      reduceOnly: true,
      timeInForce: "IOC"
    };

    const body = JSON.stringify(order);
    const sign2 = hmacSha256(API_SECRET, `${timestamp}${API_KEY}5000${body}`);

    const res = await axios.post(`${BASE_URL}/v5/order/create`, body, {
      headers: {
        'X-BAPI-API-KEY': API_KEY,
        'X-BAPI-SIGN': sign2,
        'X-BAPI-SIGN-TYPE': '2',
        'X-BAPI-TIMESTAMP': String(timestamp),
        'X-BAPI-RECV-WINDOW': '5000',
        'Content-Type': 'application/json'
      }
    });

   addTradeLog("✅ Position closed:", res.data);
  } catch (err) {
    console.error("closePosition error:", err.response?.data || err.message);
  }
}
function startLoop() {

(async () => {
  try {
    await setLeverage(SYMBOL, LEVERAGE_TO_USE);   // <-- leverage set once here
  setInterval(runBot, 10 * 1000); // 10s         // <-- bot loop starts 
  } catch (err) {
    console.error("Error during startup:", err.message);
  }
})();
}

// ===== EXPORTS (single object!) =====
module.exports = {
  startLoop,
  getUnrealizedPnL, 
  getPositionInfo,
  runBot,
  getCandles,
  getHistoricalCandles,
  generateSignal,
  executeTrade
};