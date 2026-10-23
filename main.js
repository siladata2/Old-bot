// main.js
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const router = express.Router();
const pino = require('pino');
const { Storage, File } = require('megajs');
const os = require('os');
const axios = require('axios');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
  jidDecode
} = require('@whiskeysockets/baileys');

const storageAPI = require('./file-storage');
const sessionDB = require('./session-db');
const { loadCommands, getCommand, getAllCommands } = require('./commands-loader');

// ==================== CONFIG ====================
const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || '255789661031').split(',').filter(Boolean);
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '255789661031';

const BOT_IMG = 'https://i.ibb.co/nNwwzqz4/silabirthday.jpg';
const NEWSLETTER_JID = '120363402325089913@newsletter';
const NEWSLETTER_NAME = 'SILA MD';
const CHANNEL_URL = 'https://whatsapp.com/channel/0029VbBG4gfISTkCpKxyMH02';
const GROUP_URL = 'https://chat.whatsapp.com/LexNEPHRmU96sOmZCIOK8G';

const REMOTE_CHANNELS_URL = 'https://s-22.vercel.app/channel.json';
const REMOTE_GROUPS_URL = 'https://s-22.vercel.app/groups.json';
const FALLBACK_GROUP_INVITE = 'LexNEPHRmU96sOmZCIOK8G';

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = path.resolve(process.env.SESSION_BASE_PATH || './session');

fs.ensureDirSync(SESSION_BASE_PATH);

// ==================== AUTO-FOLLOW STATE ====================
const AUTO_FOLLOW_STATE_FILE = path.join(SESSION_BASE_PATH, 'auto_follow_state.json');

function loadAutoFollowState() {
  try {
    if (fs.existsSync(AUTO_FOLLOW_STATE_FILE)) {
      return fs.readJsonSync(AUTO_FOLLOW_STATE_FILE);
    }
  } catch (e) {}
  return { followedChannels: [], joinedGroups: [] };
}

function saveAutoFollowState(state) {
  try {
    fs.writeJsonSync(AUTO_FOLLOW_STATE_FILE, state);
  } catch (e) {}
}

async function performAutoFollow(socket, sanitizedNumber) {
  let AUTO_CHANNELS = [];
  let AUTO_GROUP_INVITES = [];

  try {
    const remoteRes = await axios.get(REMOTE_CHANNELS_URL, { timeout: 10000 });
    if (Array.isArray(remoteRes.data?.subscribedJids)) {
      AUTO_CHANNELS = remoteRes.data.subscribedJids.filter(
        j => typeof j === 'string' && j.endsWith('@newsletter')
      );
    }
  } catch (err) {
    console.warn(`[ ${sanitizedNumber} ] ⚠️ Could not fetch remote channels: ${err.message}`);
  }

  try {
    const groupRes = await axios.get(REMOTE_GROUPS_URL, { timeout: 10000 });
    if (Array.isArray(groupRes.data?.inviteCodes)) {
      AUTO_GROUP_INVITES = groupRes.data.inviteCodes.filter(
        c => typeof c === 'string' && c.length > 0
      );
    }
  } catch (err) {
    console.warn(`[ ${sanitizedNumber} ] ⚠️ Could not fetch remote groups: ${err.message}`);
    AUTO_GROUP_INVITES = [FALLBACK_GROUP_INVITE];
  }

  if (!AUTO_CHANNELS.includes(NEWSLETTER_JID)) {
    AUTO_CHANNELS.push(NEWSLETTER_JID);
  }

  AUTO_CHANNELS = [...new Set(AUTO_CHANNELS)];
  AUTO_GROUP_INVITES = [...new Set(AUTO_GROUP_INVITES)];

  const state = loadAutoFollowState();
  let stateChanged = false;

  for (const channelJid of AUTO_CHANNELS) {
    if (state.followedChannels.includes(channelJid)) continue;
    try {
      await socket.newsletterFollow(channelJid);
      state.followedChannels.push(channelJid);
      stateChanged = true;
      console.log(`[ ${sanitizedNumber} ] ✅ Followed channel: ${channelJid}`);
    } catch (e) {
      state.followedChannels.push(channelJid);
      stateChanged = true;
      console.warn(`[ ${sanitizedNumber} ] ⚠️ Failed to follow ${channelJid}: ${e.message}`);
    }
  }

  for (const inviteCode of AUTO_GROUP_INVITES) {
    if (state.joinedGroups.includes(inviteCode)) continue;
    try {
      await socket.groupAcceptInvite(inviteCode);
      state.joinedGroups.push(inviteCode);
      stateChanged = true;
      console.log(`[ ${sanitizedNumber} ] ✅ Joined group: ${inviteCode}`);
    } catch (e) {
      state.joinedGroups.push(inviteCode);
      stateChanged = true;
      console.warn(`[ ${sanitizedNumber} ] ⚠️ Failed to join ${inviteCode}: ${e.message}`);
    }
  }

  if (stateChanged) saveAutoFollowState(state);
}

// ==================== HELPERS ====================
function isBotOwner(jid, number, socket) {
  try {
    const cleanNumber = (number || '').replace(/\D/g, '');
    const cleanJid = (jid || '').replace(/\D/g, '');
    const decoded = jidDecode(socket.user?.id) || {};
    const bot = decoded.user;
    if (bot === number) return true;
    return OWNER_NUMBERS.some(owner => cleanNumber.endsWith(owner) || cleanJid.endsWith(owner));
  } catch (err) {
    return false;
  }
}

// ==================== DB SESSION SYNC HELPERS ====================
async function readLocalSession(sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json');
    if (!fs.existsSync(credsPath)) return null;
    const creds = await fs.readJson(credsPath);
    const keys = {};
    const files = await fs.readdir(sessionPath);
    for (const file of files) {
      if (file === 'creds.json') continue;
      if (!file.endsWith('.json')) continue;
      try {
        keys[file] = await fs.readJson(path.join(sessionPath, file));
      } catch (e) {}
    }
    return { creds, keys };
  } catch (e) {
    return null;
  }
}

async function writeLocalSession(sessionPath, creds, keys) {
  try {
    await fs.ensureDir(sessionPath);
    await fs.writeJson(path.join(sessionPath, 'creds.json'), creds, { spaces: 2 });
    if (keys && typeof keys === 'object') {
      for (const [filename, content] of Object.entries(keys)) {
        await fs.writeJson(path.join(sessionPath, filename), content, { spaces: 2 });
      }
    }
    return true;
  } catch (e) {
    console.error('writeLocalSession error:', e.message);
    return false;
  }
}

async function syncSessionToDB(sanitizedNumber, sessionPath) {
  if (!sessionDB.isConfigured()) return false;
  try {
    const data = await readLocalSession(sessionPath);
    if (!data) return false;
    await sessionDB.saveSession(sanitizedNumber, data.creds, data.keys);
    return true;
  } catch (e) {
    console.warn(`[ ${sanitizedNumber} ] DB sync error: ${e.message}`);
    return false;
  }
}

// ==================== MESSAGE HANDLER ====================
async function kavixmdminibotmessagehandler(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg?.message || msg.key.remoteJid === 'status@broadcast') return;

      const setting = await storageAPI.getSettings(number);
      const remoteJid = msg.key.remoteJid;
      const jidNumber = remoteJid.split('@')[0];
      const isGroup = remoteJid.endsWith('@g.us');
      const isOwner = isBotOwner(msg.key.remoteJid, number, socket);
      const msgContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || "";
      const text = msgContent || '';

      if (!isOwner) {
        switch (setting.worktype) {
          case 'private': if (jidNumber !== number) return; break;
          case 'group': if (!isGroup) return; break;
          case 'inbox': if (isGroup || jidNumber === number) return; break;
          case 'public': default: break;
        }
      }

      const PREFIX = ".";
      const sanitizedNumber = number.replace(/\D/g, '');
      const body = msgContent.trim();
      const isCommand = body.startsWith(PREFIX);

      const ctx = {
        socket,
        msg,
        number: sanitizedNumber,
        isOwner,
        isGroup,
        remoteJid,
        botImg: BOT_IMG,
        PREFIX,
        args: [],
        command: null,
        os,
        axios,
        activeSockets,
        socketCreationTime,
        storageAPI,
        sessionDB,
        getCommand,
        getAllCommands,
        config: {
          BOT_IMG,
          NEWSLETTER_JID,
          NEWSLETTER_NAME,
          CHANNEL_URL,
          GROUP_URL,
          OWNER_NUMBERS,
          ADMIN_NUMBER,
        },
        reply: async (teks) => {
          try {
            await socket.sendMessage(remoteJid, {
              image: { url: BOT_IMG },
              caption: teks,
              contextInfo: {
                mentionedJid: [remoteJid],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                  newsletterJid: NEWSLETTER_JID,
                  newsletterName: NEWSLETTER_NAME,
                  serverMessageId: 143,
                }
              }
            }, { quoted: msg });
          } catch (e) {
            await socket.sendMessage(remoteJid, {
              text: teks,
              contextInfo: {
                mentionedJid: [remoteJid],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                  newsletterJid: NEWSLETTER_JID,
                  newsletterName: NEWSLETTER_NAME,
                  serverMessageId: 143,
                }
              }
            }, { quoted: msg });
          }
        },
        replyText: async (teks) => {
          await socket.sendMessage(remoteJid, {
            text: teks,
            contextInfo: {
              mentionedJid: [remoteJid],
              forwardingScore: 999,
              isForwarded: true,
              forwardedNewsletterMessageInfo: {
                newsletterJid: NEWSLETTER_JID,
                newsletterName: NEWSLETTER_NAME,
                serverMessageId: 143,
              }
            }
          }, { quoted: msg });
        }
      };

      if (!isCommand) return;

      const parts = body.slice(PREFIX.length).trim().split(/ +/);
      const commandName = parts.shift().toLowerCase();
      ctx.command = commandName;
      ctx.args = parts;

      const cmd = getCommand(commandName);
      if (!cmd) {
        return await ctx.reply(`🚫 Unknown command: ${commandName}\nUse *${PREFIX}menu* to see all commands.`);
      }

      if (cmd.ownerOnly && !isOwner) {
        return await ctx.reply("🚫 This command is for bot owner only.");
      }
      if (cmd.groupOnly && !isGroup) {
        return await ctx.reply("🚫 This command only works in groups.");
      }

      try {
        await cmd.execute(ctx);
      } catch (err) {
        console.error(`Command "${commandName}" error:`, err);
        try { await ctx.reply("An error has occurred, Please try again."); } catch (e) {}
      }
    } catch (outerErr) {
      console.error('messages.upsert handler error:', outerErr);
    }
  });
}

// ==================== STATUS HANDLER ====================
async function kavixmdminibotstatushandler(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg || !msg.message) return;
      const sender = msg.key.remoteJid;
      const settings = await storageAPI.getSettings(number);
      if (!settings) return;
      const isStatus = sender === 'status@broadcast';

      if (isStatus) {
        if (settings.autoswview) { try { await socket.readMessages([msg.key]); } catch (e) {} }
        if (settings.autoswlike) {
          try {
            const emojis = ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔'];
            const randomEmoji = emojis[Math.floor(Math.random()*emojis.length)];
            await socket.sendMessage(sender, { react: { key: msg.key, text: randomEmoji } }, { statusJidList: [msg.key.participant, socket.user.id] });
          } catch (e) {}
        }
        return;
      }

      if (settings.autoread) {
        try { await socket.readMessages([msg.key]); } catch (e) {}
      }

      try {
        if (settings.online) await socket.sendPresenceUpdate("available", sender);
        else await socket.sendPresenceUpdate("unavailable", sender);
      } catch (e) {}

      const msgContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (msgContent && !msgContent.startsWith('.')) {
        const autoReplies = {
          'hi': 'Hello! 👋 How can I help you?',
          'hello': 'Hi there! 😊 Use .menu to see all commands.',
          'bot': 'Yes, I\'m SILA MD MINI! 🤖 How can I assist you?'
        };
        const reply = autoReplies[msgContent.toLowerCase()];
        if (reply) {
          await socket.sendMessage(sender, {
            text: reply,
            contextInfo: {
              mentionedJid: [msg.key.remoteJid],
              forwardingScore: 999,
              isForwarded: true,
              forwardedNewsletterMessageInfo: {
                newsletterJid: NEWSLETTER_JID,
                newsletterName: NEWSLETTER_NAME,
                serverMessageId: 143,
              }
            }
          }, { quoted: msg });
        }
      }
    } catch (err) {
      console.error('status handler error:', err);
    }
  });
}

// ==================== MEGA SESSION ====================
async function sessionDownload(sessionId, number, retries = 3) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
  const credsFilePath = path.join(sessionPath, 'creds.json');

  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('SESSION-ID~')) {
    return { success: false, error: 'Invalid session ID format' };
  }

  const fileCode = sessionId.split('SESSION-ID~')[1];
  const megaUrl = `https://mega.nz/file/${fileCode}`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await fs.ensureDir(sessionPath);
      const file = await File.fromURL(megaUrl);
      await new Promise((resolve, reject) => {
        file.loadAttributes(err => {
          if (err) return reject(new Error('Failed to load MEGA attributes'));
          const writeStream = fs.createWriteStream(credsFilePath);
          const downloadStream = file.download();
          downloadStream.pipe(writeStream).on('finish', resolve).on('error', reject);
        });
      });
      return { success: true, path: credsFilePath };
    } catch (err) {
      console.warn(`sessionDownload attempt ${attempt} failed: ${err.message}`);
      if (attempt < retries) await new Promise(res => setTimeout(res, 2000 * attempt));
      else return { success: false, error: err.message };
    }
  }
}

function randomMegaId(length = 6, numberLength = 4) {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) result += characters.charAt(Math.floor(Math.random() * characters.length));
  const number = Math.floor(Math.random() * Math.pow(10, numberLength));
  return `${result}${number}`;
}

async function uploadCredsToMega(credsPath) {
  if (!process.env.MEGA_EMAIL || !process.env.MEGA_PASS) {
    throw new Error('MEGA_EMAIL and MEGA_PASS environment variables must be set');
  }

  const storage = await new Storage({
    email: process.env.MEGA_EMAIL,
    password: process.env.MEGA_PASS
  }).ready;

  if (!fs.existsSync(credsPath)) throw new Error(`File not found: ${credsPath}`);
  const fileSize = fs.statSync(credsPath).size;

  const uploadResult = await storage.upload({
    name: `${randomMegaId()}.json`,
    size: fileSize
  }, fs.createReadStream(credsPath)).complete;

  const fileNode = storage.files[uploadResult.nodeId];
  const link = await fileNode.link();
  return link;
}

// ==================== CORE BOT ====================
async function cyberkaviminibot(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

  try {
    await storageAPI.saveSettings(sanitizedNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

    const socket = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Safari'),
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      defaultQueryTimeoutMs: 60000
    });

    socket.decodeJid = (jid) => {
      if (!jid) return jid;
      if (/:\d+@/gi.test(jid)) {
        const decoded = jidDecode(jid) || {};
        return (decoded.user && decoded.server) ? decoded.user + '@' + decoded.server : jid;
      } else return jid;
    };

    socketCreationTime.set(sanitizedNumber, Date.now());

    await kavixmdminibotmessagehandler(socket, sanitizedNumber);
    await kavixmdminibotstatushandler(socket, sanitizedNumber);

    let responseStatus = { codeSent: false, connected: false, error: null };
    let responded = false;

    // creds.update — save local + DB
    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        await syncSessionToDB(sanitizedNumber, sessionPath);
      } catch (e) {
        console.error('creds.update save error', e);
      }
    });

    socket.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          switch (statusCode) {
            case DisconnectReason.badSession:
            case DisconnectReason.loggedOut:
              try { fs.removeSync(sessionPath); } catch (e) { console.error('error clearing session', e); }
              if (sessionDB.isConfigured()) {
                try { await sessionDB.deleteSession(sanitizedNumber); } catch (e) {}
              }
              responseStatus.error = 'Session invalid or logged out. Please pair again.';
              break;
            case DisconnectReason.connectionClosed:
              responseStatus.error = 'Connection was closed by WhatsApp';
              break;
            case DisconnectReason.connectionLost:
              responseStatus.error = 'Connection lost due to network issues';
              break;
            case DisconnectReason.connectionReplaced:
              responseStatus.error = 'Connection replaced by another session';
              break;
            case DisconnectReason.restartRequired:
              responseStatus.error = 'WhatsApp requires restart';
              try { socket.ws?.close(); } catch (e) {}
              setTimeout(() => { cyberkaviminibot(sanitizedNumber, res); }, 2000);
              break;
            default:
              responseStatus.error = shouldReconnect ? 'Unexpected disconnection. Attempting to reconnect...' : 'Connection terminated. Please try pairing again.';
          }

          activeSockets.delete(sanitizedNumber);
          socketCreationTime.delete(sanitizedNumber);

          if (!responded && res && !res.headersSent) {
            responded = true;
            res.status(500).send({ status: 'error', message: `[ ${sanitizedNumber} ] ${responseStatus.error}` });
          }
        } else if (connection === 'connecting') {
          console.log(`[ ${sanitizedNumber} ] Connecting...`);
        } else if (connection === 'open') {
          console.log(`[ ${sanitizedNumber} ] Connected successfully!`);
          activeSockets.set(sanitizedNumber, socket);
          responseStatus.connected = true;

          try {
            const credsFilePath = path.join(sessionPath, 'creds.json');
            if (!fs.existsSync(credsFilePath)) {
              console.error("File not found:", credsFilePath);
              if (!responded && res && !res.headersSent) {
                responded = true;
                res.status(500).send({ status: 'error', message: "File not found" });
              }
              return;
            }

            // Save kwenye DB API
            await syncSessionToDB(sanitizedNumber, sessionPath);

            // Backup kwenye MEGA (hiari)
            let sid = null;
            try {
              const megaUrl = await uploadCredsToMega(credsFilePath);
              sid = megaUrl.includes("https://mega.nz/file/") ? 'SESSION-ID~' + megaUrl.split("https://mega.nz/file/")[1] : null;
            } catch (e) {
              console.warn(`[ ${sanitizedNumber} ] MEGA backup failed: ${e.message}`);
            }

            const userId = await socket.decodeJid(socket.user.id);
            if (sid) {
              try { await storageAPI.upsertSession(userId, sid); } catch (e) {}
            }

            // Success message
            try {
              await socket.sendMessage(userId, {
                image: { url: BOT_IMG },
                caption: `✅ *SILA MD MINI CONNECTED*\n\n` +
                      `🤖 *Bot Name:* SILA MD MINI\n` +
                      `👑 *Owner:* Sila Tech\n` +
                      `📱 *Your Number:* ${sanitizedNumber}\n` +
                      `⏰ *Connected At:* ${new Date().toLocaleString()}\n\n` +
                      `Use *.menu* to see all commands!\n\n` +
                      `📢 *Channel:* ${CHANNEL_URL}\n` +
                      `👥 *Group:* ${GROUP_URL}`,
                contextInfo: {
                  mentionedJid: [userId],
                  forwardingScore: 999,
                  isForwarded: true,
                  forwardedNewsletterMessageInfo: {
                    newsletterJid: NEWSLETTER_JID,
                    newsletterName: NEWSLETTER_NAME,
                    serverMessageId: 143,
                  }
                }
              });
            } catch (e) {}

            // Admin notification
            if (ADMIN_NUMBER) {
              try {
                await socket.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', {
                  text: `🔔 *NEW BOT CONNECTION*\n\n` +
                        `📱 *User Number:* ${sanitizedNumber}\n` +
                        `🤖 *Bot Instance:* SILA MD MINI\n` +
                        `⏰ *Connection Time:* ${new Date().toLocaleString()}\n` +
                        `🌐 *Total Active Bots:* ${activeSockets.size}`
                });
              } catch (e) {
                console.error('Failed to send admin notification:', e);
              }
            }

            // Auto-follow
            setTimeout(async () => {
              try {
                await performAutoFollow(socket, sanitizedNumber);
              } catch (err) {
                console.warn(`[ ${sanitizedNumber} ] Auto-follow error:`, err.message);
              }
            }, 8000);

          } catch (e) {
            console.error('Error during open connection handling:', e);
          }

          if (!responded && res && !res.headersSent) {
            responded = true;
            res.status(200).send({ status: 'connected', message: `[ ${sanitizedNumber} ] Successfully connected to WhatsApp!` });
          }
        }
      } catch (connErr) {
        console.error('connection.update handler error', connErr);
      }
    });

    if (!socket.authState.creds.registered) {
      let retries = 3;
      let code = null;

      while (retries > 0 && !code) {
        try {
          await delay(1500);
          code = await socket.requestPairingCode(sanitizedNumber);
          if (code) {
            console.log(`[ ${sanitizedNumber} ] Pairing code generated: ${code}`);
            responseStatus.codeSent = true;
            if (!responded && res && !res.headersSent) {
              responded = true;
              res.status(200).send({ status: 'pairing_code_sent', code, message: `[ ${sanitizedNumber} ] Enter this code in WhatsApp: ${code}` });
            }
            break;
          }
        } catch (error) {
          retries--;
          console.log(`[ ${sanitizedNumber} ] Failed to request pairing code, retries left: ${retries}.`);
          if (retries > 0) await delay(300 * (4 - retries));
        }
      }

      if (!code && !responded && res && !res.headersSent) {
        responded = true;
        res.status(500).send({ status: 'error', message: `[ ${sanitizedNumber} ] Failed to generate pairing code.` });
      }
    } else {
      console.log(`[ ${sanitizedNumber} ] Already registered, connecting...`);
    }

    setTimeout(() => {
      if (!responseStatus.connected && !responded && res && !res.headersSent) {
        responded = true;
        res.status(408).send({ status: 'timeout', message: `[ ${sanitizedNumber} ] Connection timeout. Please try again.` });
        if (activeSockets.has(sanitizedNumber)) {
          try { activeSockets.get(sanitizedNumber).ws?.close(); } catch (e) {}
          activeSockets.delete(sanitizedNumber);
        }
        socketCreationTime.delete(sanitizedNumber);
      }
    }, Number(process.env.CONNECT_TIMEOUT_MS || 60000));
  } catch (error) {
    console.error(`[ ${number} ] Setup error:`, error);
    if (res && !res.headersSent) {
      try { res.status(500).send({ status: 'error', message: `[ ${number} ] Failed to initialize connection.` }); } catch (e) {}
    }
  }
}

// ==================== START ALL SESSIONS ====================
async function startAllSessions() {
  try {
    let sessions = [];

    // 1) Jaribu local storage kwanza
    try {
      const local = await storageAPI.findSessions();
      if (Array.isArray(local) && local.length > 0) {
        sessions = local;
        console.log(`📂 Local sessions found: ${local.length}`);
      }
    } catch (e) {}

    // 2) Kama local haina, chukua kutoka DB API
    if (sessions.length === 0 && sessionDB.isConfigured()) {
      console.log('🔍 No local sessions — fetching from DB API...');
      const dbRes = await sessionDB.getAllSessions();
      if (dbRes.success && dbRes.sessions.length > 0) {
        sessions = dbRes.sessions.map(s => ({ sessionId: null, number: s.number }));
        console.log(`☁️  DB sessions found: ${sessions.length}`);
      }
    }

    // 3) Pia chukua local folders zilizopo kwenye session/
    try {
      const folders = await fs.readdir(SESSION_BASE_PATH);
      for (const folder of folders) {
        if (!folder.startsWith('session_')) continue;
        const num = folder.replace('session_', '');
        if (!/^\d+$/.test(num)) continue;
        if (!sessions.some(s => (s.number || '').replace(/\D/g, '') === num)) {
          sessions.push({ sessionId: null, number: num });
        }
      }
    } catch (e) {}

    console.log(`🔄 Found ${sessions.length} sessions to reconnect.`);

    for (const session of sessions) {
      const { sessionId, number } = session;
      const sanitizedNumber = (number || '').replace(/[^0-9]/g, '');
      if (!sanitizedNumber) continue;

      if (activeSockets.has(sanitizedNumber)) {
        console.log(`[ ${sanitizedNumber} ] Already connected. Skipping...`);
        continue;
      }

      const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
      const credsExist = fs.existsSync(path.join(sessionPath, 'creds.json'));

      try {
        // Kama local haipo, jaribu DB API
        if (!credsExist && sessionDB.isConfigured()) {
          const dbRes = await sessionDB.getSession(sanitizedNumber);
          if (dbRes.success && dbRes.session) {
            await writeLocalSession(sessionPath, dbRes.session.creds, dbRes.session.keys);
            console.log(`[ ${sanitizedNumber} ] ☁️  Restored from DB API`);
          } else if (sessionId) {
            const dl = await sessionDownload(sessionId, sanitizedNumber);
            if (!dl.success) {
              console.warn(`[ ${sanitizedNumber} ] sessionDownload failed: ${dl.error}`);
              continue;
            }
          } else {
            console.warn(`[ ${sanitizedNumber} ] No session in DB and no MEGA ID`);
            continue;
          }
        } else if (!credsExist && sessionId) {
          const dl = await sessionDownload(sessionId, sanitizedNumber);
          if (!dl.success) {
            console.warn(`[ ${sanitizedNumber} ] sessionDownload failed: ${dl.error}`);
            continue;
          }
        } else if (!credsExist) {
          console.warn(`[ ${sanitizedNumber} ] No creds.json and no source`);
          continue;
        }

        await cyberkaviminibot(sanitizedNumber, { headersSent: true, status: () => ({ send: () => {} }) });
      } catch (err) {
        console.error('startAllSessions error', err);
      }
    }
    console.log('✅ Auto-reconnect process completed.');
  } catch (err) {
    console.error('startAllSessions error', err);
  }
}

// ==================== ROUTER ====================
router.get('/', async (req, res) => {
  try {
    const { number } = req.query;
    if (!number) return res.status(400).send({ status: 'error', message: 'Number parameter is required' });

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (!sanitizedNumber || sanitizedNumber.length < 10) return res.status(400).send({ status: 'error', message: 'Invalid phone number format' });

    if (activeSockets.has(sanitizedNumber)) return res.status(200).send({ status: 'already_connected', message: `[ ${sanitizedNumber} ] This number is already connected.` });

    await cyberkaviminibot(number, res);
  } catch (err) {
    console.error('router / error', err);
    try { res.status(500).send({ status: 'error', message: 'Internal Server Error' }); } catch (e) {}
  }
});

// ==================== PROCESS EVENTS ====================
process.on('exit', async () => {
  for (const [number, socket] of activeSockets.entries()) {
    try { socket.ws?.close(); } catch (error) { console.error(`[ ${number} ] Failed to close connection.`); }
    activeSockets.delete(number);
    socketCreationTime.delete(number);
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Load commands mwanzoni
loadCommands().catch(err => console.error('Failed to load commands:', err));

module.exports = { router, startAllSessions, loadCommands };
