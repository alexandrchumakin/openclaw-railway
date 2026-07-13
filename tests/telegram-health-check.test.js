const assert = require('node:assert/strict');
const test = require('node:test');

const { hasStuckTelegramRestart } = require('../telegram-health-check');


function status(accountOverrides = {}, channelOverrides = {}) {
  return {
    channels: {
      telegram: {
        configured: true,
        running: false,
        lastError: null,
        ...channelOverrides,
      },
    },
    channelAccounts: {
      telegram: [{
        accountId: 'default',
        enabled: true,
        configured: true,
        running: false,
        restartPending: false,
        ...accountOverrides,
      }],
    },
  };
}


test('detects the persistent Telegram stop-timeout restart state', () => {
  assert.equal(hasStuckTelegramRestart(status({
    restartPending: true,
    lastError: 'channel stop timed out after 5000ms',
  })), true);
});


test('does not flag a running Telegram poller with historical errors', () => {
  assert.equal(hasStuckTelegramRestart(status({
    running: true,
    restartPending: true,
    lastError: 'channel stop timed out after 5000ms',
  })), false);
});


test('does not restart the container for unrelated Telegram failures', () => {
  assert.equal(hasStuckTelegramRestart(status({
    restartPending: true,
    lastError: '401 Unauthorized',
  })), false);
});
