// logger.js
let tradeLogs = [];

function addTradeLog(message) {
  const log = `[${new Date().toLocaleTimeString()}] ${message}`;
  console.log(log); // ✅ Terminal log
  tradeLogs.push(log);

  // keep last 200 logs only
  if (tradeLogs.length > 200) tradeLogs.shift();
}

function getLogs() {
  return tradeLogs;
}

module.exports = { addTradeLog, getLogs };
