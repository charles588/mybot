require('dotenv').config();
const axios = require('axios');

(async () => {
  const url = `${process.env.BASE_URL}/v5/market/tickers?category=linear`;
  try {
    const res = await axios.get(url);
    const symbols = res.data.result.list.map(s => s.symbol);
    console.log(symbols.includes('XRPUSDT') ? '✅ XRPUSDT found' : '❌ XRPUSDT not found');
  } catch (err) {
    console.error(err.response?.data || err.message);
  }
})();