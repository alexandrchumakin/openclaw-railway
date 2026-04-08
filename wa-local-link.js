#!/usr/bin/env node
// wa-local-link.js — Run on your LOCAL machine to link WhatsApp
//
// Usage:
//   npm install @whiskeysockets/baileys pino qrcode-terminal
//   node wa-local-link.js +1234567890
//
// Uses pairing code method (no QR scanning needed).
// Enter the code in WhatsApp > Linked Devices > Link with Phone Number

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const AUTH_DIR = path.join(__dirname, '.wa-local-creds');
let retries = 0;
let pairingRequested = false;

// Get phone number from args or prompt
async function getPhoneNumber() {
  const arg = process.argv[2];
  if (arg) return arg.replace(/[^0-9]/g, '');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('Enter your WhatsApp phone number (with country code, e.g. 79161234567): ', answer => {
      rl.close();
      resolve(answer.replace(/[^0-9]/g, ''));
    });
  });
}

async function main() {
  const phoneNumber = await getPhoneNumber();
  if (!phoneNumber || phoneNumber.length < 10) {
    console.error('Invalid phone number. Include country code (no + or spaces).');
    process.exit(1);
  }

  console.log(`\nPhone: ${phoneNumber}`);
  console.log('Connecting to WhatsApp...\n');

  await startConnection(phoneNumber);
}

async function startConnection(phoneNumber) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    const v = await fetchLatestBaileysVersion();
    version = v.version;
    console.log(`Using WA version: ${version.join('.')}`);
  } catch {
    version = [2, 3000, 1033893291]; // fallback version
    console.log('Using fallback WA version');
  }

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Chrome', 'Chrome', '145.0.0'],
    version,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Request pairing code when we get a QR event (means connection is ready)
    if (qr && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log('='.repeat(50));
        console.log(`  PAIRING CODE: ${code}`);
        console.log('='.repeat(50));
        console.log('\nOpen WhatsApp on your phone:');
        console.log('  Settings > Linked Devices > Link a Device');
        console.log('  Tap "Link with Phone Number" (bottom)');
        console.log(`  Enter code: ${code}\n`);
      } catch (e) {
        console.error('Failed to get pairing code:', e.message);
        // Fall back to QR
        try {
          const qrterm = require('qrcode-terminal');
          qrterm.generate(qr, { small: true }, (out) => {
            console.log(out);
            console.log('Or scan this QR code instead.\n');
          });
        } catch {
          console.log('QR data (paste into a QR generator):', qr);
        }
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const msg = lastDisconnect?.error?.message || 'unknown';

      if (code === DisconnectReason?.loggedOut) {
        console.error('Logged out. Run: rm -rf .wa-local-creds && node wa-local-link.js');
        process.exit(1);
      }

      retries++;
      if (retries > 10) {
        console.error('Too many retries. Run: rm -rf .wa-local-creds && node wa-local-link.js');
        process.exit(1);
      }

      console.log(`Retry ${retries}/10 (code=${code}, ${msg})`);
      pairingRequested = false;
      setTimeout(() => startConnection(phoneNumber), 3000 * retries);
    }

    if (connection === 'open') {
      setTimeout(() => {
        console.log('\nWhatsApp linked successfully!\n');

        const bundle = {};
        for (const f of fs.readdirSync(AUTH_DIR)) {
          if (f.endsWith('.json')) {
            bundle[f] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
          }
        }
        const encoded = Buffer.from(JSON.stringify(bundle)).toString('base64');

        console.log('='.repeat(60));
        console.log('Set this as WHATSAPP_CREDS env var in Railway:');
        console.log('='.repeat(60));
        console.log(encoded);
        console.log('='.repeat(60));
        console.log('\n1. Copy the base64 string above');
        console.log('2. Railway dashboard > Variables > Add:');
        console.log('   WHATSAPP_CREDS = <paste>');
        console.log('3. Railway auto-redeploys with credentials\n');

        sock.end();
        process.exit(0);
      }, 2000);
    }
  });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
