#!/usr/bin/env node
// wa-local-link.js — Run this on your LOCAL machine to link WhatsApp
// Generates a QR code, you scan it, then it outputs credentials
// to paste as a Railway environment variable.
//
// Usage:
//   npm install @whiskeysockets/baileys pino
//   node wa-local-link.js

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, '.wa-local-creds');

async function main() {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  console.log('Connecting to WhatsApp...\n');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['OpenClaw Bot', 'Chrome', '22.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n^^^ Scan the QR code above with WhatsApp ^^^');
      console.log('Open WhatsApp > Settings > Linked Devices > Link a Device\n');
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason?.loggedOut) {
        console.log('Connection lost, retrying...');
        setTimeout(main, 3000);
      } else {
        console.error('Logged out. Delete .wa-local-creds/ and try again.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      // Wait a moment for all auth files to be written
      setTimeout(() => {
        console.log('\nWhatsApp linked successfully!\n');

        // Bundle all auth files into a single base64 string
        const bundle = {};
        for (const f of fs.readdirSync(AUTH_DIR)) {
          if (f.endsWith('.json')) {
            bundle[f] = fs.readFileSync(path.join(AUTH_DIR, f), 'utf8');
          }
        }
        const encoded = Buffer.from(JSON.stringify(bundle)).toString('base64');

        console.log('='.repeat(60));
        console.log('Set this as WHATSAPP_CREDS environment variable in Railway:');
        console.log('='.repeat(60));
        console.log(encoded);
        console.log('='.repeat(60));
        console.log('\nSteps:');
        console.log('1. Copy the base64 string above');
        console.log('2. Go to Railway dashboard > your service > Variables');
        console.log('3. Add variable: WHATSAPP_CREDS = <paste the string>');
        console.log('4. Railway will redeploy automatically');
        console.log('5. WhatsApp should connect on the new deploy\n');

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
