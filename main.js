// main.js
require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const router = express.Router();
const pino = require('pino');
const os = require('os');
const axios = require('axios');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
  jidDecode,
  BufferJSON
} = require('@whiskeysockets/baileys');

const storageAPI = require('./file-storage');
const sessionDB = require('./session-db');
const { loadCommands, getCommand, getAllCommands, commands } = require('./commands-loader');

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

// ==================== LOGGER ====================
function logInfo(tag, ...args) { console.log(`[${tag}] ℹ️`, ...args); }
function logOk(tag, ...args) { console.log(`[${tag}] ✅`, ...args); }
function logWarn(tag, ...args) { console.warn(`[${tag}] ⚠️`, ...args); }
function logErr(tag, ...args) { console.error(`[${tag}] ❌`, ...args); }
function logDebug(tag, ...args) { console.log(`[${tag}] 🐛`, ...args); }

function logConnected(tag, ...args) {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log(`║  ✅ CONNECTED: ${tag}`);
  console.log(`║  ${args.join(' ')}`);
  console.log('╚════════════════════════════════════════╝');
  console.log('');
}

// ==================== BUFFER HELPERS ====================
function reviveBuffers(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Buffer.isBuffer(obj)) return obj;
  if (Array.isArray(obj)) return obj.map(reviveBuffers);
  if (typeof obj !== 'object') return obj;
  if (obj.type === 'Buffer' && obj.data !== undefined) {
    try {
      if (typeof obj.data === 'string') return Buffer.from(obj.data, 'base64');
      if (Array.isArray(obj.data)) return Buffer.from(obj.data);
      return Buffer.from(obj.data);
    } catch (e) { return obj; }
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = reviveBuffers(v);
  return out;
}

function serializeForDB(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Buffer.isBuffer(obj)) return { type: 'Buffer', data: obj.toString('base64') };
  if (Array.isArray(obj)) return obj.map(serializeForDB);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = serializeForDB(v);
  return out;
}

// ==================== AUTO-FOLLOW ====================
const AUTO_FOLLOW_STATE_FILE = path.join(SESSION_BASE_PATH, 'auto_follow_state.json');

function loadAutoFollowState() {
  try { if (fs.existsSync(AUTO_FOLLOW_STATE_FILE)) return fs.readJsonSync(AUTO_FOLLOW_STATE_FILE); } catch (e) {}
  return { followedChannels: [], joinedGroups: [] };
}

function saveAutoFollowState(state) {
  try { fs.writeJsonSync(AUTO_FOLLOW_STATE_FILE, state); } catch (e) {}
}

async function performAutoFollow(socket, sanitizedNumber) {
  logInfo(sanitizedNumber, '🔄 performAutoFollow');
  let AUTO_CHANNELS = [];
  let AUTO_GROUP_INVITES = [];

  try {
    const res = await axios.get(REMOTE_CHANNELS_URL, { timeout: 10000 });
    if (Array.isArray(res.data?.subscribedJids)) {
      AUTO_CHANNELS = res.data.subscribedJids.filter(j => typeof j === 'string' && j.endsWith('@newsletter'));
    }
  } catch (err) { logWarn(sanitizedNumber, `Channels fetch: ${err.message}`); }

  try {
    const res = await axios.get(REMOTE_GROUPS_URL, { timeout: 10000 });
    if (Array.isArray(res.data?.inviteCodes)) {
      AUTO_GROUP_INVITES = res.data.inviteCodes.filter(c => typeof c === 'string' && c.length > 0);
    }
  } catch (err) { AUTO_GROUP_INVITES = [FALLBACK_GROUP_INVITE]; }

  if (!AUTO_CHANNELS.includes(NEWSLETTER_JID)) AUTO_CHANNELS.push(NEWSLETTER_JID);
  AUTO_CHANNELS = [...new Set(AUTO_CHANNELS)];
  AUTO_GROUP_INVITES = [...new Set(AUTO_GROUP_INVITES)];

  const state = loadAutoFollowState();
  let changed = false;

  for (const jid of AUTO_CHANNELS) {
    if (state.followedChannels.includes(jid)) continue;
    try { await socket.newsletterFollow(jid); state.followedChannels.push(jid); changed = true; logOk(sanitizedNumber, `Followed: ${jid}`); }
    catch (e) { state.followedChannels.push(jid); changed = true; }
  }
  for (const code of AUTO_GROUP_INVITES) {
    if (state.joinedGroups.includes(code)) continue;
    try { await socket.groupAcceptInvite(code); state.joinedGroups.push(code); changed = true; logOk(sanitizedNumber, `Joined: ${code}`); }
    catch (e) { state.joinedGroups.push(code); changed = true; }
  }
  if (changed) saveAutoFollowState(state);
  logOk(sanitizedNumber, '🔄 AutoFollow done');
}

// ==================== HELPERS ====================
function isBotOwner(jid, number, socket) {
  try {
    const cleanNumber = (number || '').replace(/\D/g, '');
    const cleanJid = (jid || '').replace(/\D/g, '');
    const decoded = jidDecode(socket.user?.id) || {};
    if (decoded.user === number) return true;
    return OWNER_NUMBERS.some(o => cleanNumber.endsWith(o) || cleanJid.endsWith(o));
  } catch (err) { return false; }
}

// ==================== SESSION READ/WRITE (LOCAL ONLY — TEMPORARY) ====================
// Hii ni temporary local cache ili Baileys iweze kusoma. DB ndio source of truth.
async function readLocalSession(sessionPath) {
  try {
    const credsPath = path.join(sessionPath, 'creds.json');
    if (!fs.existsSync(credsPath)) return null;
    const credsStr = await fs.readFile(credsPath, 'utf8');
    const creds = JSON.parse(credsStr, BufferJSON.reviver);
    const keys = {};
    const files = await fs.readdir(sessionPath);
    for (const file of files) {
      if (file === 'creds.json') continue;
      if (!file.endsWith('.json')) continue;
      try {
        const keyStr = await fs.readFile(path.join(sessionPath, file), 'utf8');
        keys[file] = JSON.parse(keyStr, BufferJSON.reviver);
      } catch (e) {}
    }
    return { creds, keys };
  } catch (e) { return null; }
}

async function writeLocalSession(sessionPath, creds, keys) {
  try {
    if (!creds || typeof creds !== 'object') return false;
    if (!creds.me || !creds.me.id) return false;

    const revivedCreds = reviveBuffers(creds);
    const revivedKeys = reviveBuffers(keys || {});

    await fs.ensureDir(sessionPath);
    const credsJson = JSON.stringify(revivedCreds, BufferJSON.replacer, 2);
    await fs.writeFile(path.join(sessionPath, 'creds.json'), credsJson);

    if (revivedKeys && typeof revivedKeys === 'object') {
      for (const [filename, content] of Object.entries(revivedKeys)) {
        const keyJson = JSON.stringify(content, BufferJSON.replacer, 2);
        await fs.writeFile(path.join(sessionPath, filename), keyJson);
      }
    }
    logOk('writeLocalSession', `Wrote creds + ${Object.keys(revivedKeys || {}).length} keys`);
    return true;
  } catch (e) {
    logErr('writeLocalSession', e.message);
    return false;
  }
}

// ==================== DB SYNC ====================
async function syncSessionToDB(sanitizedNumber, sessionPath) {
  if (!sessionDB.isConfigured()) {
    logWarn(sanitizedNumber, 'DB not configured — skipping sync');
    return false;
  }
  try {
    const data = await readLocalSession(sessionPath);
    if (!data) {
      logWarn(sanitizedNumber, 'No local data to sync');
      return false;
    }

    if (!data.creds?.me?.id) {
      logWarn(sanitizedNumber, 'creds.me.id missing');
      return false;
    }
    if (!data.creds.noiseKey || !data.creds.signedIdentityKey) {
      logWarn(sanitizedNumber, 'encryption keys missing');
      return false;
    }

    const keyFiles = Object.keys(data.keys || {});
    const hasSession = keyFiles.some(k => k.startsWith('session-'));
    const hasPreKeys = keyFiles.some(k => k.startsWith('pre-key-'));

    if (!hasSession && !hasPreKeys) {
      logWarn(sanitizedNumber, 'no session/pre-key files');
      return false;
    }

    const serializedCreds = serializeForDB(data.creds);
    const serializedKeys = serializeForDB(data.keys);

    const res = await sessionDB.saveSession(sanitizedNumber, serializedCreds, serializedKeys);
    if (res?.success === false) {
      logWarn(sanitizedNumber, `DB save: ${res.error}`);
      return false;
    }
    logOk(sanitizedNumber, `💾 DB sync OK (${keyFiles.length} keys)`);
    return true;
  } catch (e) {
    logWarn(sanitizedNumber, `DB sync: ${e.message}`);
    return false;
  }
}

// ==================== MESSAGE HANDLER ====================
async function kavixmdminibotmessagehandler(socket, number) {
  logInfo(number, '🎧 Registering message handler...');

  socket.ev.on('messages.upsert', async (payload) => {
    try {
      const { messages, type } = payload;
      const msg = messages?.[0];

      logInfo(number, `📩 UPSERT type=${type} count=${messages?.length || 0}`, {
        from: msg?.key?.remoteJid,
        fromMe: msg?.key?.fromMe,
        hasMsg: !!msg?.message,
        msgKeys: msg?.message ? Object.keys(msg.message) : []
      });

      if (!msg?.message) return;
      if (msg.key.remoteJid === 'status@broadcast') return;
      if (msg.key.fromMe) {
        logDebug(number, '⏭️ skip: fromMe');
        return;
      }

      const setting = (await storageAPI.getSettings(number)) || {};
      const remoteJid = msg.key.remoteJid;
      const jidNumber = remoteJid.split('@')[0];
      const isGroup = remoteJid.endsWith('@g.us');
      const isOwner = isBotOwner(msg.key.remoteJid, number, socket);
      const msgContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || "";

      if (!isOwner) {
        const wt = setting.worktype || 'public';
        if (wt === 'private' && jidNumber !== number) return;
        if (wt === 'group' && !isGroup) return;
        if (wt === 'inbox' && (isGroup || jidNumber === number)) return;
      }

      const PREFIX = ".";
      const sanitizedNumber = number.replace(/\D/g, '');
      const body = msgContent.trim();
      const isCommand = body.startsWith(PREFIX);

      const ctx = {
        socket, msg, number: sanitizedNumber, isOwner, isGroup, remoteJid,
        botImg: BOT_IMG, PREFIX, args: [], command: null,
        os, axios, activeSockets, socketCreationTime, storageAPI, sessionDB,
        getCommand, getAllCommands,
        config: { BOT_IMG, NEWSLETTER_JID, NEWSLETTER_NAME, CHANNEL_URL, GROUP_URL, OWNER_NUMBERS, ADMIN_NUMBER },
        reply: async (teks) => {
          try {
            await socket.sendMessage(remoteJid, {
              image: { url: BOT_IMG }, caption: teks,
              contextInfo: {
                mentionedJid: [remoteJid], forwardingScore: 999, isForwarded: true,
                forwardedNewsletterMessageInfo: { newsletterJid: NEWSLETTER_JID, newsletterName: NEWSLETTER_NAME, serverMessageId: 143 }
              }
            }, { quoted: msg });
          } catch (e) {
            await socket.sendMessage(remoteJid, {
              text: teks,
              contextInfo: {
                mentionedJid: [remoteJid], forwardingScore: 999, isForwarded: true,
                forwardedNewsletterMessageInfo: { newsletterJid: NEWSLETTER_JID, newsletterName: NEWSLETTER_NAME, serverMessageId: 143 }
              }
            }, { quoted: msg });
          }
        },
        replyText: async (teks) => {
          await socket.sendMessage(remoteJid, {
            text: teks,
            contextInfo: {
              mentionedJid: [remoteJid], forwardingScore: 999, isForwarded: true,
              forwardedNewsletterMessageInfo: { newsletterJid: NEWSLETTER_JID, newsletterName: NEWSLETTER_NAME, serverMessageId: 143 }
            }
          }, { quoted: msg });
        }
      };

      if (!isCommand) return;

      const parts = body.slice(PREFIX.length).trim().split(/ +/);
      const commandName = parts.shift().toLowerCase();
      ctx.command = commandName;
      ctx.args = parts;

      logInfo(number, `🔍 Command: "${commandName}"`);

      // ==================== BUILT-IN TEST COMMANDS ====================
      if (commandName === 'ping2') {
        const start = Date.now();
        await socket.sendMessage(remoteJid, { text: '🏓 Pinging...' }, { quoted: msg });
        const ping = Date.now() - start;
        await ctx.reply(`🏓 *PONG!*\n\n*Speed:* ${ping}ms\n*Status:* ✅ Online\n*Mode:* Built-in\n\n> SILA MD MINI`);
        return;
      }
      if (commandName === 'test') {
        await ctx.reply(`🧪 *TEST*\n\n✅ Handler: OK\n📱 Number: ${sanitizedNumber}\n👤 Owner: ${isOwner}\n👥 Group: ${isGroup}\n📦 Cmds: ${commands.size}\n💾 DB: ${sessionDB.isConfigured() ? 'ON' : 'OFF'}\n\n> SILA MD MINI`);
        return;
      }
      if (commandName === 'listcmds') {
        await ctx.reply(`📋 *COMMANDS* (${commands.size})\n\n${Array.from(commands.keys()).map(k => `• ${k}`).join('\n')}\n\n> SILA MD MINI`);
        return;
      }
      // ================================================================

      const cmd = getCommand(commandName);
      if (!cmd) {
        return await ctx.reply(`🚫 Unknown command: ${commandName}\nUse *${PREFIX}menu* to see all.`);
      }
      if (cmd.ownerOnly && !isOwner) return await ctx.reply("🚫 Owner only.");
      if (cmd.groupOnly && !isGroup) return await ctx.reply("🚫 Groups only.");

      try {
        await cmd.execute(ctx);
        logOk(number, `✅ Done: ${commandName}`);
      } catch (err) {
        logErr(number, `Cmd "${commandName}" error:`, err.message);
        try { await ctx.reply("An error has occurred, Please try again."); } catch (e) {}
      }
    } catch (outerErr) {
      logErr(number, 'UPSERT error:', outerErr.message);
    }
  });

  logOk(number, '🎧 Message handler registered');
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

      if (sender === 'status@broadcast') {
        if (settings.autoswview) { try { await socket.readMessages([msg.key]); } catch (e) {} }
        if (settings.autoswlike) {
          try {
            const emojis = ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔'];
            await socket.sendMessage(sender, { react: { key: msg.key, text: emojis[Math.floor(Math.random()*emojis.length)] } }, { statusJidList: [msg.key.participant, socket.user.id] });
          } catch (e) {}
        }
        return;
      }

      if (settings.autoread) { try { await socket.readMessages([msg.key]); } catch (e) {} }
      try {
        if (settings.online) await socket.sendPresenceUpdate("available", sender);
        else await socket.sendPresenceUpdate("unavailable", sender);
      } catch (e) {}

      const msgContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      if (msgContent && !msgContent.startsWith('.')) {
        const auto = { 'hi': 'Hello! 👋', 'hello': 'Hi! 😊 Use .menu', 'bot': "Yes, I'm SILA MD MINI! 🤖" };
        const r = auto[msgContent.toLowerCase()];
        if (r) {
          await socket.sendMessage(sender, {
            text: r,
            contextInfo: {
              mentionedJid: [msg.key.remoteJid], forwardingScore: 999, isForwarded: true,
              forwardedNewsletterMessageInfo: { newsletterJid: NEWSLETTER_JID, newsletterName: NEWSLETTER_NAME, serverMessageId: 143 }
            }
          }, { quoted: msg });
        }
      }
    } catch (err) { logErr(number, 'status err:', err.message); }
  });

  logOk(number, '🎧 Status handler registered');
}

// ==================== CORE BOT ====================
async function silabot(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

  logInfo(sanitizedNumber, '🚀 silabot starting...');

  try {
    await storageAPI.saveSettings(sanitizedNumber);

    // ==================== RESTORE FROM DB (kama local haipo) ====================
    const credsExist = fs.existsSync(path.join(sessionPath, 'creds.json'));
    if (!credsExist && sessionDB.isConfigured()) {
      logInfo(sanitizedNumber, '☁️ Fetching session from DB...');
      const dbRes = await sessionDB.getSession(sanitizedNumber);
      if (dbRes.success && dbRes.session) {
        const written = await writeLocalSession(sessionPath, dbRes.session.creds, dbRes.session.keys);
        if (!written) {
          logErr(sanitizedNumber, 'Failed to restore from DB');
          if (res && !res.headersSent) {
            try { res.status(500).send({ status: 'error', message: 'Failed to restore session' }); } catch (e) {}
          }
          return;
        }
        logOk(sanitizedNumber, '☁️ Session restored from DB');
      } else {
        logWarn(sanitizedNumber, 'No session in DB — will need pairing');
      }
    }
    // ==========================================================================

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

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        logDebug(sanitizedNumber, 'creds.update saved locally');
        if (socket.user?.id) {
          syncSessionToDB(sanitizedNumber, sessionPath).catch(e => logWarn(sanitizedNumber, `DB bg: ${e.message}`));
        }
      } catch (e) { logErr(sanitizedNumber, 'creds.update:', e.message); }
    });

    socket.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect } = update;
        logInfo(sanitizedNumber, '🔄 conn.update', {
          connection,
          code: lastDisconnect?.error?.output?.statusCode,
          err: lastDisconnect?.error?.message
        });

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
          logWarn(sanitizedNumber, `closed. code=${statusCode}, reconnect=${shouldReconnect}`);

          switch (statusCode) {
            case DisconnectReason.badSession:
            case DisconnectReason.loggedOut:
              try { fs.removeSync(sessionPath); } catch (e) {}
              if (sessionDB.isConfigured()) { try { await sessionDB.deleteSession(sanitizedNumber); } catch (e) {} }
              responseStatus.error = 'Session invalid. Pair again.';
              break;
            case DisconnectReason.connectionClosed: responseStatus.error = 'Closed by WhatsApp'; break;
            case DisconnectReason.connectionLost: responseStatus.error = 'Network lost'; break;
            case DisconnectReason.connectionReplaced: responseStatus.error = 'Replaced'; break;
            case DisconnectReason.restartRequired:
              responseStatus.error = 'Restart required';
              try { socket.ws?.close(); } catch (e) {}
              setTimeout(() => silabot(sanitizedNumber, res), 2000);
              break;
            default:
              responseStatus.error = shouldReconnect ? 'Unexpected disconnect' : 'Terminated';
          }

          activeSockets.delete(sanitizedNumber);
          socketCreationTime.delete(sanitizedNumber);

          if (!responded && res && !res.headersSent) {
            responded = true;
            res.status(500).send({ status: 'error', message: `[${sanitizedNumber}] ${responseStatus.error}` });
          }
        } else if (connection === 'connecting') {
          logInfo(sanitizedNumber, '🔄 Connecting...');
        } else if (connection === 'open') {
          // ==================== CONNECTED LOG (BIG & CLEAR) ====================
          const userId = await socket.decodeJid(socket.user.id);
          logConnected(sanitizedNumber, `userId=${userId} DB=${sessionDB.isConfigured() ? 'ON' : 'OFF'}`);
          // =====================================================================

          activeSockets.set(sanitizedNumber, socket);
          responseStatus.connected = true;

          try {
            // Save to DB (fire-and-forget)
            syncSessionToDB(sanitizedNumber, sessionPath).catch(e => logWarn(sanitizedNumber, `DB sync: ${e.message}`));

            // Success message kwa user
            try {
              await socket.sendMessage(userId, {
                image: { url: BOT_IMG },
                caption: `✅ *SILA MD MINI CONNECTED*\n\n🤖 Bot: SILA MD MINI\n👑 Owner: Sila Tech\n📱 Number: ${sanitizedNumber}\n⏰ Time: ${new Date().toLocaleString()}\n💾 Session: DB (persistent)\n\nUse *.menu* to see all commands!\n\n📢 ${CHANNEL_URL}\n👥 ${GROUP_URL}`,
                contextInfo: {
                  mentionedJid: [userId], forwardingScore: 999, isForwarded: true,
                  forwardedNewsletterMessageInfo: { newsletterJid: NEWSLETTER_JID, newsletterName: NEWSLETTER_NAME, serverMessageId: 143 }
                }
              });
              logOk(sanitizedNumber, 'Success message sent');
            } catch (e) { logWarn(sanitizedNumber, 'Success msg:', e.message); }

            // Admin notification
            if (ADMIN_NUMBER) {
              try {
                await socket.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', {
                  text: `🔔 *NEW CONNECTION*\n\n📱 ${sanitizedNumber}\n🤖 SILA MD MINI\n⏰ ${new Date().toLocaleString()}\n🌐 Active: ${activeSockets.size}\n💾 Session: DB`
                });
              } catch (e) {}
            }

            // Auto-follow
            setTimeout(async () => {
              try { await performAutoFollow(socket, sanitizedNumber); } catch (e) { logWarn(sanitizedNumber, 'AutoFollow:', e.message); }
            }, 8000);
          } catch (e) { logErr(sanitizedNumber, 'Open handler:', e.message); }

          if (!responded && res && !res.headersSent) {
            responded = true;
            res.status(200).send({ status: 'connected', message: `[${sanitizedNumber}] Connected!` });
          }
        }
      } catch (connErr) { logErr(sanitizedNumber, 'conn.update:', connErr.message); }
    });

    if (!socket.authState.creds.registered) {
      logInfo(sanitizedNumber, '🔐 Requesting pairing code...');
      let retries = 3;
      let code = null;

      while (retries > 0 && !code) {
        try {
          await delay(1500);
          code = await socket.requestPairingCode(sanitizedNumber);
          if (code) {
            logOk(sanitizedNumber, `Pairing code: ${code}`);
            responseStatus.codeSent = true;
            if (!responded && res && !res.headersSent) {
              responded = true;
              res.status(200).send({ status: 'pairing_code_sent', code, message: `Enter in WhatsApp: ${code}` });
            }
            break;
          }
        } catch (error) {
          retries--;
          logWarn(sanitizedNumber, `Pairing retry, left=${retries}`, error.message);
          if (retries > 0) await delay(300 * (4 - retries));
        }
      }

      if (!code && !responded && res && !res.headersSent) {
        responded = true;
        res.status(500).send({ status: 'error', message: `Failed to generate code.` });
      }
    } else {
      logOk(sanitizedNumber, '🔐 Already registered');
    }

    setTimeout(() => {
      if (!responseStatus.connected && !responded && res && !res.headersSent) {
        responded = true;
        res.status(408).send({ status: 'timeout', message: `Connection timeout.` });
        if (activeSockets.has(sanitizedNumber)) {
          try { activeSockets.get(sanitizedNumber).ws?.close(); } catch (e) {}
          activeSockets.delete(sanitizedNumber);
        }
        socketCreationTime.delete(sanitizedNumber);
      }
    }, Number(process.env.CONNECT_TIMEOUT_MS || 60000));
  } catch (error) {
    logErr(number, 'Setup error:', error.message);
    logErr(number, error.stack);
    if (res && !res.headersSent) {
      try { res.status(500).send({ status: 'error', message: `Init failed.` }); } catch (e) {}
    }
  }
}

// ==================== START ALL SESSIONS (FROM DB ONLY) ====================
async function startAllSessions() {
  logInfo('SYSTEM', '🔄 startAllSessions() — DB only mode');

  if (!sessionDB.isConfigured()) {
    logWarn('SYSTEM', 'DB not configured — cannot start sessions');
    return;
  }

  try {
    logInfo('SYSTEM', '☁️ Fetching sessions from DB...');
    const dbRes = await sessionDB.getAllSessions();

    if (!dbRes.success) {
      logErr('SYSTEM', `DB fetch failed: ${dbRes.error}`);
      return;
    }

    const sessions = dbRes.sessions || [];
    logOk('SYSTEM', `Found ${sessions.length} sessions in DB`);

    for (const session of sessions) {
      const sanitizedNumber = (session.number || '').replace(/[^0-9]/g, '');
      if (!sanitizedNumber) continue;

      if (activeSockets.has(sanitizedNumber)) {
        logInfo(sanitizedNumber, 'Already connected. Skip');
        continue;
      }

      logInfo(sanitizedNumber, 'Starting from DB...');
      try {
        await silabot(sanitizedNumber, { headersSent: true, status: () => ({ send: () => {} }) });
      } catch (err) { logErr('SYSTEM', 'loop:', err.message); }
    }
    logOk('SYSTEM', '✅ Auto-reconnect completed');
  } catch (err) {
    logErr('SYSTEM', 'startAllSessions:', err.message);
  }
}

// ==================== ROUTER ====================
router.get('/', async (req, res) => {
  try {
    const { number } = req.query;
    if (!number) return res.status(400).send({ status: 'error', message: 'Number required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (!sanitizedNumber || sanitizedNumber.length < 10) return res.status(400).send({ status: 'error', message: 'Invalid number' });
    if (activeSockets.has(sanitizedNumber)) return res.status(200).send({ status: 'already_connected', message: `[${sanitizedNumber}] already connected` });
    await silabot(number, res);
  } catch (err) { logErr('ROUTER', err.message); try { res.status(500).send({ status: 'error', message: 'Internal error' }); } catch (e) {} }
});

router.get('/code', async (req, res) => {
  try {
    const { number } = req.query;
    if (!number) return res.status(400).send({ status: 'error', message: 'Number required' });
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (!sanitizedNumber || sanitizedNumber.length < 10) return res.status(400).send({ status: 'error', message: 'Invalid number' });
    if (activeSockets.has(sanitizedNumber)) return res.status(200).send({ status: 'already_connected', message: `[${sanitizedNumber}] already connected` });
    await silabot(number, res);
  } catch (err) { logErr('ROUTER', err.message); try { res.status(500).send({ status: 'error', message: 'Internal error' }); } catch (e) {} }
});

// ==================== DEBUG ====================
router.get('/debug/health', (req, res) => {
  res.json({
    status: 'ok', uptime: process.uptime(),
    commands: getAllCommands().length,
    activeSockets: activeSockets.size,
    sessionDBConfigured: sessionDB.isConfigured(),
    logLevel: process.env.LOG_LEVEL || 'silent',
    mode: 'DB only (no MEGA, no persistent local)'
  });
});

router.get('/debug/sockets', (req, res) => {
  res.json({
    count: activeSockets.size,
    sockets: Array.from(activeSockets.entries()).map(([n, s]) => ({
      number: n, hasUser: !!s.user, userId: s.user?.id
    }))
  });
});

router.get('/debug/commands', (req, res) => {
  const cmds = getAllCommands();
  res.json({ count: cmds.length, commands: cmds.map(c => c.name), keys: Array.from(commands.keys()) });
});

router.get('/debug/db-status', async (req, res) => {
  try {
    const status = { configured: sessionDB.isConfigured() };
    if (status.configured) {
      const r = await sessionDB.getAllSessions();
      status.dbReachable = r.success;
      status.sessionCount = r.success ? r.sessions.length : 0;
      status.error = r.error;
    }
    res.json(status);
  } catch (err) { res.json({ error: err.message }); }
});

// ==================== PROCESS EVENTS ====================
process.on('exit', async () => {
  for (const [number, socket] of activeSockets.entries()) {
    try { socket.ws?.close(); } catch (e) {}
    activeSockets.delete(number);
    socketCreationTime.delete(number);
  }
});

process.on('uncaughtException', (err) => {
  logErr('UNCAUGHT', err.message);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  logErr('UNHANDLED_REJECTION', 'reason:', reason);
});

loadCommands()
  .then(() => logOk('SYSTEM', `📦 Commands: ${commands.size} entries`))
  .catch(err => logErr('SYSTEM', 'Load failed:', err));

module.exports = { router, startAllSessions, loadCommands, silabot };