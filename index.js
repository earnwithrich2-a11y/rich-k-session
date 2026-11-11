const express = require('express');
const path = require('path');
const pino = require('pino');
const fs = require('fs');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  delay,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 5050;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active pairing sessions in memory
const sessions = new Map();

app.post('/api/pair', async (req, res) => {
  let phone = String(req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Please enter a valid phone number with country code' });
  }

  const sessionId = `pair_${phone}_${Date.now()}`;
  const authDir = path.join('/tmp', sessionId);

  sessions.set(sessionId, { status: 'starting', code: null, creds: null });
  res.json({ sessionId });

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
      },
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
      await delay(1500);
      try {
        const code = await sock.requestPairingCode(phone);
        sessions.set(sessionId, { status: 'waiting_for_approval', code });
      } catch (err) {
        sessions.set(sessionId, { status: 'error', error: err.message || 'Failed to request code' });
      }
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        sessions.set(sessionId, { status: 'connected' });

        try {
          const credsPath = path.join(authDir, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const raw = fs.readFileSync(credsPath, 'utf8');
            const b64 = Buffer.from(raw).toString('base64');
            const finalSessionId = `RICH-K-MD~${b64}`;

            sessions.set(sessionId, { status: 'done', sessionString: finalSessionId });

            // Send session directly to their WhatsApp DM
            const userJid = `${phone}@s.whatsapp.net`;
            await sock.sendMessage(userJid, {
              text: `*RICH-K-MD BOT SESSION ID*\n\nYour session ID is ready:\n\n\`\`\`${finalSessionId}\`\`\`\n\nCopy this and paste it on https://app.richkaurex.site/deploy to run your bot!`,
            });
          }
        } catch (e) {
          console.error('Session export error:', e);
        }

        // Wait 10 seconds before closing so WhatsApp finishes key sync
        setTimeout(() => {
          try { sock.end(); } catch (_) {}
          try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (_) {}
        }, 10000);
      } else if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (!shouldReconnect && sessions.get(sessionId)?.status !== 'done') {
          sessions.set(sessionId, { status: 'failed', error: 'Connection closed' });
        }
      }
    });
  } catch (err) {
    sessions.set(sessionId, { status: 'error', error: err.message });
  }
});

app.get('/api/status/:id', (req, res) => {
  const data = sessions.get(req.params.id) || { status: 'not_found' };
  res.json(data);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Session generator running on port ${PORT}`);
});
