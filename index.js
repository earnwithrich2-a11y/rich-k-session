const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeSessions = new Map();

function cleanFolder(folderPath) {
  try {
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Error cleaning folder:', err.message);
  }
}

// ---------------- PAIRING CODE ROUTE ----------------
app.get('/pair', async (req, res) => {
  let phone = (req.query.phone || '').toString().replace(/[^0-9]/g, '');

  if (!phone || phone.length < 9) {
    return res.status(400).json({ error: 'Please enter a valid phone number with country code' });
  }

  const id = 'sess_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
  const sessionDir = path.join('/tmp', id);

  const sessionData = {
    id,
    phone,
    dir: sessionDir,
    sock: null,
    code: null,
    sessionId: null,
    status: 'requesting_code',
    error: null
  };
  activeSessions.set(id, sessionData);

  async function startPairingSocket() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: ['Chrome (Linux)', '', '']
      });

      sessionData.sock = sock;
      sock.ev.on('creds.update', saveCreds);

      // Request pairing code only if not yet registered
      if (!sock.authState.creds.registered && !sessionData.code) {
        await delay(2000);
        let code = await sock.requestPairingCode(phone);
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        sessionData.code = code;
        sessionData.status = 'code_ready';

        if (!res.headersSent) {
          res.json({ id, code });
        }
      }

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'open') {
          sessionData.status = 'connected';
          try {
            await delay(4000);
            const credsPath = path.join(sessionDir, 'creds.json');
            if (fs.existsSync(credsPath)) {
              const credsRaw = fs.readFileSync(credsPath, 'utf-8');
              const fullSessionId = `Gifted~${Buffer.from(credsRaw).toString('base64')}`;

              sessionData.sessionId = fullSessionId;
              sessionData.status = 'completed';

              const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
              await sock.sendMessage(userJid, {
                text: `*RICH-K-MD BOT SESSION ID*\n\n` +
                      `Here is your bot session ID. Copy it completely:\n\n` +
                      `\`\`\`${fullSessionId}\`\`\`\n\n` +
                      `⚠️ *Keep this private! Paste it into RICH-K-MD Deploy Bot.*`
              });

              await delay(20000);
            }
          } catch (err) {
            console.error('Error sending session DM:', err);
          } finally {
            try { await sock.logout(); } catch (e) {}
            cleanFolder(sessionDir);
            activeSessions.delete(id);
          }
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          // If not logged out, WhatsApp is restarting socket to finalize pairing handshake
          if (statusCode && statusCode !== DisconnectReason.loggedOut && statusCode !== 401) {
            console.log('Reconnecting to finalize pairing...');
            await delay(2000);
            startPairingSocket();
          } else {
            sessionData.status = 'failed';
            cleanFolder(sessionDir);
            activeSessions.delete(id);
          }
        }
      });

    } catch (err) {
      console.error('Socket error:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Failed to start pairing' });
      }
      cleanFolder(sessionDir);
      activeSessions.delete(id);
    }
  }

  startPairingSocket();
});

// ---------------- QR CODE ROUTE ----------------
app.get('/qr-code', async (req, res) => {
  const id = 'qr_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
  const sessionDir = path.join('/tmp', id);

  const sessionData = {
    id,
    dir: sessionDir,
    sock: null,
    qrDataUrl: null,
    sessionId: null,
    status: 'generating_qr'
  };
  activeSessions.set(id, sessionData);

  let responded = false;

  async function startQRSocket() {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }),
        browser: ['Chrome (Linux)', '', '']
      });

      sessionData.sock = sock;
      sock.ev.on('creds.update', saveCreds);

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !sessionData.qrDataUrl) {
          try {
            const url = await QRCode.toDataURL(qr, { scale: 8, margin: 2 });
            sessionData.qrDataUrl = url;
            sessionData.status = 'qr_ready';
            if (!responded) {
              responded = true;
              return res.json({ id, qr: url });
            }
          } catch (e) {}
        }

        if (connection === 'open') {
          sessionData.status = 'connected';
          try {
            await delay(4000);
            const credsPath = path.join(sessionDir, 'creds.json');
            if (fs.existsSync(credsPath)) {
              const credsRaw = fs.readFileSync(credsPath, 'utf-8');
              const fullSessionId = `Gifted~${Buffer.from(credsRaw).toString('base64')}`;

              sessionData.sessionId = fullSessionId;
              sessionData.status = 'completed';

              const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
              await sock.sendMessage(userJid, {
                text: `*RICH-K-MD BOT SESSION ID*\n\n` +
                      `Here is your bot session ID:\n\n` +
                      `\`\`\`${fullSessionId}\`\`\`\n\n` +
                      `⚠️ *Keep this private!*`
              });

              await delay(20000);
            }
          } catch (err) {
            console.error('Error sending session DM:', err);
          } finally {
            try { await sock.logout(); } catch (e) {}
            cleanFolder(sessionDir);
            activeSessions.delete(id);
          }
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          if (statusCode && statusCode !== DisconnectReason.loggedOut && statusCode !== 401) {
            await delay(2000);
            startQRSocket();
          } else {
            sessionData.status = 'failed';
            cleanFolder(sessionDir);
            activeSessions.delete(id);
          }
        }
      });

      setTimeout(() => {
        if (!responded) {
          responded = true;
          cleanFolder(sessionDir);
          activeSessions.delete(id);
          res.status(504).json({ error: 'QR code timed out. Please try again.' });
        }
      }, 20000);

    } catch (err) {
      cleanFolder(sessionDir);
      activeSessions.delete(id);
      if (!responded) {
        responded = true;
        return res.status(500).json({ error: err.message || 'QR generation failed' });
      }
    }
  }

  startQRSocket();
});

// ---------------- STATUS ROUTE ----------------
app.get('/status', (req, res) => {
  const id = req.query.id;
  const sess = activeSessions.get(id);

  if (!sess) {
    return res.json({ status: 'expired_or_completed' });
  }

  return res.json({
    status: sess.status,
    sessionId: sess.sessionId || null,
    error: sess.error || null
  });
});

app.listen(PORT, () => {
  console.log(`RICH-K-MD Session Server running on port ${PORT}`);
});
