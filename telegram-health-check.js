const fs = require('node:fs');


function hasStuckTelegramRestart(status) {
  const accounts = status?.channelAccounts?.telegram;
  const account = Array.isArray(accounts)
    ? accounts.find((candidate) => candidate?.accountId === 'default') || accounts[0]
    : null;
  if (!account || !account.configured || account.enabled === false || account.running) return false;

  const channelError = status?.channels?.telegram?.lastError;
  const error = String(account.lastError || channelError || '');
  return account.restartPending === true && /channel stop timed out/i.test(error);
}


function main() {
  try {
    const status = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (hasStuckTelegramRestart(status)) {
      console.error('Telegram polling is stuck in stop-timeout recovery');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Could not parse Telegram channel health');
    process.exitCode = 2;
  }
}


if (require.main === module) main();


module.exports = { hasStuckTelegramRestart };
