require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const BASE_URL = "https://api.bybit.com";
const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const SYMBOL = "BTCUSDT"; 

function getSignature(timestamp, apiKey, recvWindow, body, secret) {
  const paramStr = timestamp + apiKey + recvWindow + JSON.stringify(body);
  return crypto.createHmac('sha256', secret).update(paramStr).digest('hex');
}

// --- Get Balance ---
async function getUSDTBalance() {
  const timestamp = Date.now().toString();
  const recvWindow = '5000';

  const query = `accountType=UNIFIED&coin=USDT`;
  const sign = crypto.createHmac('sha256', API_SECRET)
    .update(timestamp + API_KEY + recvWindow + query)
    .digest('hex');

  const headers = {
    'X-BAPI-API-KEY': API_KEY,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-SIGN': sign,
    'X-BAPI-RECV-WINDOW': recvWindow
  };

  const url = `${BASE_URL}/v5/account/wallet-balance?${query}`;
  console.log("📤 Checking USDT balance...");
  const res = await axios.get(url, { headers });

  const usdt = parseFloat(res.data.result.list[0].coin[0].walletBalance);
  console.log(`💰 Available USDT: ${usdt}`);
  return usdt;
}

// --- Get Symbol Info ---
async function getSymbolInfo(symbol) {
  const url = `${BASE_URL}/v5/market/instruments-info?category=linear&symbol=${symbol}`;
  const res = await axios.get(url);
  const info = res.data.result.list[0];
  return {
    minQty: parseFloat(info.lotSizeFilter.minOrderQty),
    stepSize: parseFloat(info.lotSizeFilter.qtyStep)
  };
}
async function setLeverage(symbol, buyLev = "500", sellLev = "500") {
  const body = {
    category: "linear",
    symbol,
    buyLeverage: buyLev,
    sellLeverage: sellLev
  };

  const url = `${BASE_URL}/v5/position/set-leverage`;
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const sign = getSignature(timestamp, API_KEY, recvWindow, body, API_SECRET);

  const headers = {
    'Content-Type': 'application/json',
    'X-BAPI-API-KEY': API_KEY,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-SIGN': sign,
    'X-BAPI-RECV-WINDOW': recvWindow
  };

  console.log("⚙️ Setting leverage:", body);
  const res = await axios.post(url, body, { headers });
  console.log("✅ Leverage result:", res.data);
  return res.data;
}

// --- Place Order ---
async function buyCoin() {
  try {
    const { minQty, stepSize } = await getSymbolInfo(SYMBOL);
    console.log(`📏 ${SYMBOL} min qty: ${minQty}, step size: ${stepSize}`);

    const balance = await getUSDTBalance();
    if (balance <= 0) throw new Error("No USDT balance");

    const priceRes = await axios.get(`${BASE_URL}/v5/market/tickers?category=linear&symbol=${SYMBOL}`);
    const price = parseFloat(priceRes.data.result.list[0].lastPrice);

    let qty = 0.001;
    if (qty < minQty) throw new Error("Quantity too small");

    // ✅ Step 1: Set leverage before placing order
    await setLeverage(SYMBOL);

    // ✅ Step 2: Place order
    const body = {
      category: 'linear',
      symbol: SYMBOL,
      side: 'Buy',
      orderType: 'Market',
      qty: qty.toString(),
      timeInForce: 'GoodTillCancel'
    };

    const url = `${BASE_URL}/v5/order/create`;
    const timestamp = Date.now().toString();
    const recvWindow = '5000';
    const sign = getSignature(timestamp, API_KEY, recvWindow, body, API_SECRET);

    const headers = {
      'Content-Type': 'application/json',
      'X-BAPI-API-KEY': API_KEY,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': sign,
      'X-BAPI-RECV-WINDOW': recvWindow
    };

    console.log("📌 Sending BUY order:", body);
    const res = await axios.post(url, body, { headers });
    console.log("✅ Order result:", res.data);

  } catch (err) {
    console.error("❌ Error placing BUY order:", err.response?.data || err.message);
  }
}


(async () => {
  await buyCoin();
})();
