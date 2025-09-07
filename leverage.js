require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');

const API_KEY = process.env.API_KEY;
const API_SECRET = process.env.API_SECRET;
const BASE_URL = 'https://api.bybit.com'; // use testnet if needed

async function setLeverage() {
  const timestamp = Date.now().toString();
  const recvWindow = '5000';

  const body = JSON.stringify({
    category: 'linear',
    symbol: 'ETHUSDT',
    buyLeverage: '5',
    sellLeverage: '5'
  });

  const params = {
    apiKey: API_KEY,
    timestamp,
    recvWindow
  };

  const orderedParams = `apiKey=${API_KEY}&recvWindow=${recvWindow}&timestamp=${timestamp}`;
  const sign = crypto
    .createHmac('sha256', API_SECRET)
    .update(orderedParams + body)
    .digest('hex');

  try {
    const res = await axios.post(
      `${BASE_URL}/v5/position/set-leverage`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-BAPI-API-KEY': API_KEY,
          'X-BAPI-SIGN': sign,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow
        }
      }
    );

    console.log('✅ Leverage Set:', res.data);
  } catch (err) {
    console.error('❌ Error setting leverage:', err.response?.data || err.message);
  }
}

setLeverage();