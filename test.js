require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = 'https://api.bybit.com';

// ===== ENV =====
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
if (!API_KEY || !API_SECRET) {
  throw new Error('Missing API_KEY or API_SECRET in environment');
}

// ===== STRATEGY CONFIG =====
const SYMBOL = 'BTCUSDT';
const ENTRY_INTERVAL = '1';
const TREND_INTERVAL = '5';

const LEVERAGE_TO_USE = 150;

const RISK_PER_TRADE = 0.5; // percent of wallet
const ATR_PERIOD = 14;
const MIN_ATR_PCT = 0.0002; // adaptive ATR filter (0.03%)

const KC_EMA = 20;
const KC_ATR_MULT = 1.5;
const SL_ATR_MULT = 1.2;
const TP_ATR_MULT = 2.0;
const MIN_VOLUME = 500000; // skip low liquidity candles
const minQtyCache = {};

// ===== BOT STATE =====
let lastTradeTime = 0;
const tradeCooldown = 60 * 1000;

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
async function getMinQty(symbol) {
  if (minQtyCache[symbol]) return minQtyCache[symbol];
  try {
    const res = await axios.get(`${BASE_URL}/v5/market/instruments-info?category=linear&symbol=${symbol}`);
    const info = res.data.result.list[0];
    if (info?.lotSizeFilter?.minOrderQty) {
      const minQty = parseFloat(info.lotSizeFilter.minOrderQty);
      minQtyCache[symbol] = minQty;
      return minQty;
    }
    return 0;
  } catch (err) {
    console.error("getMinQty error:", err.message);
    return 0;
  }
}
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
function rsi(values, period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  gains /= period;
  losses /= period;
  let rs = losses === 0 ? 100 : gains / losses;
  let rsi = 100 - (100 / (1 + rs));
  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) {
      gains = (gains * (period - 1) + diff) / period;
      losses = (losses * (period - 1) + 0) / period;
    } else {
      gains = (gains * (period - 1) + 0) / period;
      losses = (losses * (period - 1) - diff) / period;
    }
    rs = losses === 0 ? 100 : gains / losses;
    rsi = 100 - (100 / (1 + rs));
  }
  return rsi;
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
    const coins = data?.result?.list?.[0]?.coin || [];
    const usdt = coins.find(c => c.coin === 'USDT');
    return parseFloat(usdt?.walletBalance || '0');
  } catch (e) {
    console.error('getUSDTBalance error:', e.response?.data || e.message);
    return 0;
  }
}
async function computeQtyByRisk(balance, entryPrice, stopLossPrice, riskPercent, symbol) {
  const riskAmount = balance * (riskPercent / 100);
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice);
  if (riskPerUnit === 0) return 0;
  let qty = riskAmount / riskPerUnit;
  const minQty = await getMinQty(symbol);
  if (qty < minQty) {
    console.log(`⚠️ Qty (${qty}) too small; adjusting to min (${minQty})`);
    qty = minQty;
  }
  return parseFloat(qty.toFixed(3));
}

// ===== SIGNAL =====
function generateSignalKeltner(c1m, c5m) {
  if (!Array.isArray(c1m) || c1m.length < KC_EMA + ATR_PERIOD + 1) return { action: 'HOLD' };
  if (!Array.isArray(c5m) || c5m.length < KC_EMA + ATR_PERIOD + 1) return { action: 'HOLD' };

  const closes1 = c1m.map(c => c.close);
  const closes5 = c5m.map(c => c.close);
  const lastCandle = c1m[c1m.length - 1];

  // skip low volume
  if (lastCandle.volume < MIN_VOLUME) return { action: 'HOLD' };

  // skip low-liquidity hours
  const hour = new Date().getUTCHours();
  if (hour < 7 || hour > 20) return { action: 'HOLD' };

  const atr1 = calcATR(c1m, ATR_PERIOD);
  const ema1 = ema(closes1, KC_EMA);
  const ema5 = ema(closes5, KC_EMA);
  const rsiVal = rsi(closes1, 14);
  if (!atr1 || !ema1 || !ema5 || !rsiVal) return { action: 'HOLD' };

  // adaptive ATR check
  if ((atr1 / lastCandle.close) < MIN_ATR_PCT) return { action: 'HOLD' };

  const upper = ema1 + KC_ATR_MULT * atr1;
  const lower = ema1 - KC_ATR_MULT * atr1;
  const lastClose = closes1[closes1.length - 1];

  const upTrend = lastClose > ema5;
  const downTrend = lastClose < ema5;

  if (upTrend && lastClose > upper && rsiVal < 70) {
    const entryPrice = lastClose;
    const stopLoss = entryPrice - SL_ATR_MULT * atr1;
    const takeProfit = entryPrice + TP_ATR_MULT * atr1;
    return { action: 'Buy', entryPrice, stopLoss, takeProfit };
  }
  if (downTrend && lastClose < lower && rsiVal > 30) {
    const entryPrice = lastClose;
    const stopLoss = entryPrice + SL_ATR_MULT * atr1;
    const takeProfit = entryPrice - TP_ATR_MULT * atr1;
    return { action: 'Sell', entryPrice, stopLoss, takeProfit };
  }
  return { action: 'HOLD' };
}
const generateSignal = (candles) => generateSignalKeltner(candles, candles);

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
    console.log('📤 Sending order payload:', order);
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
    console.log('✅ Order placed:', response.data);
    return response.data;
  } catch (err) {
    console.error('❌ Error placing order:', err.response?.data || err.message);
    return { error: err.response?.data || err.message };
  }
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

// ===== BOT LOOP =====
async function runBot() {
  if (Date.now() - lastTradeTime < tradeCooldown) {
    console.log("⏳ Cooldown active; skipping...");
    return;
  }
  console.log(`\n=== Running bot for ${SYMBOL} ===`);
  try {
    const candles = await getHistoricalCandles(SYMBOL, ENTRY_INTERVAL, 50);
    if (!candles || candles.length < 50) {
      console.log("⚠️ Not enough candles yet");
      return;
    }
    const signal = await generateSignal(candles);
    if (!signal || signal.action.toUpperCase() === "HOLD") {
      console.log("⏸ No trade signal this time.");
      return;
    }
    const alreadyInTrade = await hasOpenPosition(symbol);
if (alreadyInTrade) {
  console.log("🚫 Already in an open position, skipping new trade.");
  return;
}
    const balance = await getUSDTBalance();
    if (typeof balance !== 'number' || isNaN(balance) || balance <= 0) {
      console.log("⚠️ Could not fetch balance; skipping.");
      return;
    }
    const qty = await computeQtyByRisk(
      balance * LEVERAGE_TO_USE,
      signal.entryPrice,
      signal.stopLoss,
      RISK_PER_TRADE,
      SYMBOL
    );
    if (qty <= 0) {
      console.log("⚠️ Qty computed is 0; skipping.");
      return;
    }
    await executeTrade({
      side: signal.action,
      symbol: SYMBOL,
      qty,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit
    });
    lastTradeTime = Date.now();
  } catch (err) {
    console.error(`❌ runBot error: ${err.message}`);
  }
}
function startLoop() {
  console.log('🔄 Bot loop started (1m)…');
  runBot();
  setInterval(runBot, 60_000);
}

// ===== EXPORTS =====
module.exports = {
  startLoop,
  runBot,
  getCandles,
  getHistoricalCandles,
  generateSignal,
  executeTrade
};