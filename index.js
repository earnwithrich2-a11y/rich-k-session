const express = require('express');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Store active pairings in memory
const activeSessions = new Map();

// Helper to clean temp folder safely
function cleanFolder(folderPath) {
  try {
    if (fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Error cleaning folder:', err.message);
  }
}

// Route 1: Request pairing code
app.get('/pair', async (req, res) => {
  let phone = (req.query.phone || '').toString().replace(/[^0-9]/g, '');

  if (!phone || phone.length < 9) {
    return res.status(400).json({ error: 'Please enter a valid phone number with country code (e.g. 233...)' });
  }

  const id = 'sess_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
  const sessionDir = path.join('/tmp', id);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Chrome')
    });

    sock.ev.on('creds.update', saveCreds);

    const sessionData = {
      id,
      phone,
      dir: sessionDir,
      sock,
      code: null,
      sessionId: null,
      status: 'requesting_code',
      error: null
    };
    activeSessions.set(id, sessionData);

    // Wait a brief moment before requesting pairing code (recommended by Baileys)
    await delay(2500);

    let code = await sock.requestPairingCode(phone);
    code = code?.match(/.{1,4}/g)?.join('-') || code;

    sessionData.code = code;
    sessionData.status = 'code_ready';

    // Handle connection events
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        sessionData.status = 'connected';
        console.log(`[${phone}] WhatsApp connected successfully!`);

        try {
          await delay(3000);

          // Read creds.json and encode in Gifted format (used by bot runner)
          const credsPath = path.join(sessionDir, 'creds.json');
          if (fs.existsSync(credsPath)) {
            const credsRaw = fs.readFileSync(credsPath, 'utf-8');
            const b64 = Buffer.from(credsRaw).toString('base64');
            const fullSessionId = `Gifted~${b64}`;

            sessionData.sessionId = fullSessionId;
            sessionData.status = 'completed';

            const userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';

            // Send session to WhatsApp chat
            await sock.sendMessage(userJid, {
              text: `*RICH-K-MD BOT SESSION ID*\n\n` +
                    `Here is your bot session ID. Copy it completely:\n\n` +
                    `\`\`\`${fullSessionId}\`\`\`\n\n` +
                    `⚠️ *DO NOT SHARE THIS CODE WITH ANYONE!*`
            });

            // Keep connection alive for 25 seconds so WhatsApp syncs completely and avoids "Waiting for message"
            await delay(25000);
          }
        } catch (err) {
          console.error('Error sending session message:', err);
        } finally {
          try {
            await sock.logout();
          } catch (e) {}
          cleanFolder(sessionDir);
          activeSessions.delete(id);
        }
      } else if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log(`[${phone}] Connection closed:`, reason);
        if (reason === DisconnectReason.loggedOut) {
          sessionData.status = 'failed';
          sessionData.error = 'Logged out or rejected.';
          cleanFolder(sessionDir);
          activeSessions.delete(id);
        }
      }
    });

    return res.json({ id, code });

  } catch (error) {
    console.error('Pairing error:', error);
    cleanFolder(sessionDir);
    activeSessions.delete(id);
    return res.status(500).json({ error: error.message || 'Failed to generate pairing code' });
  }
});

// Route 2: Check status & get session ID on-screen
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
