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

// ==================== LOGGER HELPERS ====================
function logInfo(tag, ...args) { console.log(`[${tag}] ℹ️`, ...args); }
function logOk(tag, ...args) { console.log(`[${tag}] ✅`, ...args); }
function logWarn(tag, ...args) { console.warn(`[${tag}] ⚠️`, ...args); }
function logErr(tag, ...args) { console.error(`[${tag}] ❌`, ...args); }
function logDebug(tag, ...args) { console.log(`[${tag}] 🐛`, ...args); }

// ==================== BUFFER REVIVE (MUHIMU KWA DB) ====================
function reviveBuffers(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Buffer.isBuffer(obj)) return obj;
  if (Array.isArray(obj)) return obj.map(reviveBuffers);
  if (typeof obj !== 'object') return obj;

  // Detect Buffer object from JSON serialization
  if (obj.type === 'Buffer' && obj.data !== undefined) {
    try {
      if (typeof obj.data === 'string') {
        return Buffer.from(obj.data, 'base64');
      }
      if (Array.isArray(obj.data)) {
        return Buffer.from(obj.data);
      }
      return Buffer.from(obj.data);
    } catch (e) {
      return obj;
    }
  }

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = reviveBuffers(v);
  }
  return out;
}

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
  try { fs.writeJsonSync(AUTO_FOLLOW_STATE_FILE, state); } catch (e) {}
}

async function performAutoFollow(socket, sanitizedNumber) {
  logInfo(sanitizedNumber, '🔄 performAutoFollow started');
  let AUTO_CHANNELS = [];
  let AUTO_GROUP_INVITES = [];

  try {
    const remoteRes = await axios.get(REMOTE_CHANNELS_URL, { timeout: 10000 });
    if (Array.isArray(remoteRes.data?.subscribedJids)) {
      AUTO_CHANNELS = remoteRes.data.subscribedJids.filter(
        j => typeof j === 'string' && j.endsWith('@newsletter')
      );
    }
    logOk(sanitizedNumber, `Fetched ${AUTO_CHANNELS.length} channels`);
  } catch (err) {
    logWarn(sanitizedNumber, `Could not fetch remote channels: ${err.message}`);
  }

  try {
    const groupRes = await axios.get(REMOTE_GROUPS_URL, { timeout: 10000 });
    if (Array.isArray(groupRes.data?.inviteCodes)) {
      AUTO_GROUP_INVITES = groupRes.data.inviteCodes.filter(
        c => typeof c === 'string' && c.length > 0
      );
    }
    logOk(sanitizedNumber, `Fetched ${AUTO_GROUP_INVITES.length} group invites`);
  } catch (err) {
    logWarn(sanitizedNumber, `Could not fetch remote groups: ${err.message}`);
    AUTO_GROUP_INVITES = [FALLBACK_GROUP_INVITE];
  }

  if (!AUTO_CHANNELS.includes(NEWSLETTER_JID)) AUTO_CHANNELS.push(NEWSLETTER_JID);
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
      logOk(sanitizedNumber, `Followed channel: ${channelJid}`);
    } catch (e) {
      state.followedChannels.push(channelJid);
      stateChanged = true;
      logWarn(sanitizedNumber, `Failed to follow ${channelJid}: ${e.message}`);
    }
  }

  for (const inviteCode of AUTO_GROUP_INVITES) {
    if (state.joinedGroups.includes(inviteCode)) continue;
    try {
      await socket.groupAcceptInvite(inviteCode);
      state.joinedGroups.push(inviteCode);
      stateChanged = true;
      logOk(sanitizedNumber, `Joined group: ${inviteCode}`);
    } catch (e) {
      state.joinedGroups.push(inviteCode);
      stateChanged = true;
      logWarn(sanitizedNumber, `Failed to join ${inviteCode}: ${e.message}`);
    }
  }

  if (stateChanged) saveAutoFollowState(state);
  logOk(sanitizedNumber, '🔄 performAutoFollow completed');
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
// IMPORTANT: Use BufferJSON for serialization — hii ndio fix kuu!
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
  } catch (e) {
    logErr('readLocalSession', e.message);
    return null;
  }
}

async function writeLocalSession(sessionPath, creds, keys) {
  try {
    // ✅ VALIDATION
    if (!creds || typeof creds !== 'object') {
      logErr('writeLocalSession', 'creds is not an object');
      return false;
    }
    if (!creds.me || !creds.me.id) {
      logErr('writeLocalSession', 'creds.me.id missing — session is incomplete');
      return false;
    }

    // ✅ REVIVE BUFFERS KUTOKA DB (DB inasave kama {type:'Buffer', data:'base64'})
    const revivedCreds = reviveBuffers(creds);
    const revivedKeys = reviveBuffers(keys || {});

    await fs.ensureDir(sessionPath);

    // ✅ TUMIA BufferJSON.replacer — hii ndio fix kuu
    const credsJson = JSON.stringify(revivedCreds, BufferJSON.replacer, 2);
    await fs.writeFile(path.join(sessionPath, 'creds.json'), credsJson);

    if (revivedKeys && typeof revivedKeys === 'object') {
      for (const [filename, content] of Object.entries(revivedKeys)) {
        const keyJson = JSON.stringify(content, BufferJSON.replacer, 2);
        await fs.writeFile(path.join(sessionPath, filename), keyJson);
      }
    }

    logOk('writeLocalSession', `Wrote creds + ${Object.keys(revivedKeys || {}).length} key files`);
    return true;
  } catch (e) {
    logErr('writeLocalSession', e.message);
    return false;
  }
}

async function syncSessionToDB(sanitizedNumber, sessionPath) {
  if (!sessionDB.isConfigured()) return false;
  try {
    const data = await readLocalSession(sessionPath);
    if (!data) return false;

    // ✅ VALIDATION: Hakikisha creds ni kamili
    if (!data.creds || typeof data.creds !== 'object') {
      logWarn(sanitizedNumber, 'Cannot sync: creds is not an object');
      return false;
    }
    if (!data.creds.me || !data.creds.me.id) {
      logWarn(sanitizedNumber, 'Cannot sync: creds.me.id missing (not fully registered)');
      return false;
    }
    if (!data.creds.noiseKey || !data.creds.signedIdentityKey) {
      logWarn(sanitizedNumber, 'Cannot sync: encryption keys missing');
      return false;
    }

    // ✅ VALIDATION: Hakikisha keys zina session records
    const keyFiles = Object.keys(data.keys || {});
    const hasSessionKeys = keyFiles.some(k => k.startsWith('session-'));
    const hasPreKeys = keyFiles.some(k => k.startsWith('pre-key-'));

    if (!hasSessionKeys && !hasPreKeys) {
      logWarn(sanitizedNumber, 'Cannot sync: no session/pre-key files in keys', {
        keyFiles: keyFiles.slice(0, 5)
      });
      return false;
    }

    // ✅ Convert Buffers kuwa {type:'Buffer', data:'base64'} kwa DB
    // (Hii ndio DB inavyohifadhi — tuta-revive wakati wa kusoma)
    const serializedCreds = serializeForDB(data.creds);
    const serializedKeys = serializeForDB(data.keys);

    await sessionDB.saveSession(sanitizedNumber, serializedCreds, serializedKeys);
    logOk(sanitizedNumber, `💾 Session synced to DB (${keyFiles.length} keys)`);
    return true;
  } catch (e) {
    logWarn(sanitizedNumber, `DB sync error: ${e.message}`);
    return false;
  }
}

// Serialize Buffers kwa DB (JSON-safe format)
function serializeForDB(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Buffer.isBuffer(obj)) {
    return { type: 'Buffer', data: obj.toString('base64') };
  }
  if (Array.isArray(obj)) return obj.map(serializeForDB);
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = serializeForDB(v);
  }
  return out;
}

// ==================== MESSAGE HANDLER ====================
async function kavixmdminibotmessagehandler(socket, number) {
  logInfo(number, '🎧 Registering message handler...');

  socket.ev.on('messages.upsert', async (payload) => {
    try {
      const { messages, type } = payload;
      const msg = messages?.[0];

      const preview = msg?.message?.conversation
        || msg?.message?.extendedTextMessage?.text
        || msg?.message?.imageMessage?.caption
        || msg?.message?.videoMessage?.caption
        || '';

      logDebug(number, '📩 messages.upsert received', {
        type,
        count: messages?.length || 0,
        from: msg?.key?.remoteJid,
        fromMe: msg?.key?.fromMe,
        hasMessage: !!msg?.message,
        msgKeys: msg?.message ? Object.keys(msg.message) : [],
        preview: preview.slice(0, 60)
      });

      if (!msg?.message) {
        logDebug(number, '⏭️ Skipped: no msg.message');
        return;
      }
      if (msg.key.remoteJid === 'status@broadcast') {
        logDebug(number, '⏭️ Skipped: status broadcast');
        return;
      }
      if (msg.key.fromMe) {
        logDebug(number, '⏭️ Skipped: fromMe');
        return;
      }

      logInfo(number, '✅ Processing message...');

      const setting = (await storageAPI.getSettings(number)) || {};
      const remoteJid = msg.key.remoteJid;
      const jidNumber = remoteJid.split('@')[0];
      const isGroup = remoteJid.endsWith('@g.us');
      const isOwner = isBotOwner(msg.key.remoteJid, number, socket);
      const msgContent = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || "";
      const text = msgContent || '';

      logDebug(number, 'Settings/context', {
        worktype: setting?.worktype || 'public',
        jidNumber,
        isGroup,
        isOwner,
        msgContent: msgContent.slice(0, 50)
      });

      if (!isOwner) {
        const worktype = setting.worktype || 'public';
        switch (worktype) {
          case 'private':
            if (jidNumber !== number) { logDebug(number, '⏭️ Blocked: private mode'); return; }
            break;
          case 'group':
            if (!isGroup) { logDebug(number, '⏭️ Blocked: group mode'); return; }
            break;
          case 'inbox':
            if (isGroup || jidNumber === number) { logDebug(number, '⏭️ Blocked: inbox mode'); return; }
            break;
          case 'public':
          default:
            break;
        }
      }

      const PREFIX = ".";
      const sanitizedNumber = number.replace(/\D/g, '');
      const body = msgContent.trim();
      const isCommand = body.startsWith(PREFIX);

      logDebug(number, 'Command check', { body: body.slice(0, 50), isCommand, PREFIX });

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
          BOT_IMG, NEWSLETTER_JID, NEWSLETTER_NAME, CHANNEL_URL, GROUP_URL,
          OWNER_NUMBERS, ADMIN_NUMBER,
        },
        reply: async (teks) => {
          logDebug(number, '📤 Sending reply (with image)...');
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
            logOk(number, '📤 Reply sent');
          } catch (e) {
            logWarn(number, 'Image reply failed, fallback to text:', e.message);
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
            logOk(number, '📤 Text reply sent');
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

      if (!isCommand) {
        logDebug(number, '⏭️ Not a command (no prefix)');
        return;
      }

      const parts = body.slice(PREFIX.length).trim().split(/ +/);
      const commandName = parts.shift().toLowerCase();
      ctx.command = commandName;
      ctx.args = parts;

      logInfo(number, `🔍 Command: "${commandName}"`, { args: parts });

      const cmd = getCommand(commandName);
      logDebug(number, `getCommand('${commandName}') =>`, cmd ? `FOUND (${cmd.name})` : 'NOT FOUND');

      if (!cmd) {
        logWarn(number, `Unknown command: ${commandName}`);
        return await ctx.reply(`🚫 Unknown command: ${commandName}\nUse *${PREFIX}menu* to see all commands.`);
      }

      if (cmd.ownerOnly && !isOwner) {
        logWarn(number, `Command "${commandName}" blocked: ownerOnly`);
        return await ctx.reply("🚫 This command is for bot owner only.");
      }
      if (cmd.groupOnly && !isGroup) {
        logWarn(number, `Command "${commandName}" blocked: groupOnly`);
        return await ctx.reply("🚫 This command only works in groups.");
      }

      logInfo(number, `▶️ Executing command: ${commandName}`);
      try {
        await cmd.execute(ctx);
        logOk(number, `✅ Command "${commandName}" executed successfully`);
      } catch (err) {
        logErr(number, `Command "${commandName}" error:`, err.message);
        logErr(number, err.stack);

        if (err.message?.includes('Cannot convert undefined or null')) {
          logWarn(number, 'Encryption keys corrupted — session needs re-pairing');
          try { await ctx.replyText('⚠️ Session imeharibika. Tafadhali pair upya.'); } catch (e) {}
        } else {
          try { await ctx.reply("An error has occurred, Please try again."); } catch (e) {}
        }
      }
    } catch (outerErr) {
      logErr(number, 'messages.upsert handler error:', outerErr.message);
      logErr(number, outerErr.stack);
    }
  });

  logOk(number, '🎧 Message handler registered');
}

// ==================== STATUS HANDLER ====================
async function kavixmdminibotstatushandler(socket, number) {
  logInfo(number, '🎧 Registering status handler...');

  socket.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages?.[0];
      if (!msg || !msg.message) return;
      const sender = msg.key.remoteJid;
      const settings = await storageAPI.getSettings(number);
      if (!settings) return;
      const isStatus = sender === 'status@broadcast';

      if (isStatus) {
        logDebug(number, '📸 Status received');
        if (settings.autoswview) { try { await socket.readMessages([msg.key]); logDebug(number, '👁️ Status viewed'); } catch (e) {} }
        if (settings.autoswlike) {
          try {
            const emojis = ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔'];
            const randomEmoji = emojis[Math.floor(Math.random()*emojis.length)];
            await socket.sendMessage(sender, { react: { key: msg.key, text: randomEmoji } }, { statusJidList: [msg.key.participant, socket.user.id] });
            logDebug(number, '❤️ Status liked');
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
          logDebug(number, `🤖 Auto-reply: ${msgContent}`);
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
      logErr(number, 'status handler error:', err.message);
    }
  });

  logOk(number, '🎧 Status handler registered');
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
      logInfo(sanitizedNumber, `MEGA download attempt ${attempt}`);
      const file = await File.fromURL(megaUrl);
      await new Promise((resolve, reject) => {
        file.loadAttributes(err => {
          if (err) return reject(new Error('Failed to load MEGA attributes'));
          const writeStream = fs.createWriteStream(credsFilePath);
          const downloadStream = file.download();
          downloadStream.pipe(writeStream).on('finish', resolve).on('error', reject);
        });
      });
      logOk(sanitizedNumber, 'MEGA download successful');
      return { success: true, path: credsFilePath };
    } catch (err) {
      logWarn(sanitizedNumber, `MEGA download attempt ${attempt} failed: ${err.message}`);
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
  return await fileNode.link();
}

// ==================== CORE BOT (silabot) ====================
async function silabot(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

  logInfo(sanitizedNumber, '🚀 silabot starting...');

  try {
    await storageAPI.saveSettings(sanitizedNumber);
    logDebug(sanitizedNumber, 'Settings saved');

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    logDebug(sanitizedNumber, 'Auth state loaded');

    const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
    logDebug(sanitizedNumber, `Pino level: ${process.env.LOG_LEVEL || 'silent'}`);

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

    logInfo(sanitizedNumber, '📝 Registering handlers...');
    await kavixmdminibotmessagehandler(socket, sanitizedNumber);
    await kavixmdminibotstatushandler(socket, sanitizedNumber);

    let responseStatus = { codeSent: false, connected: false, error: null };
    let responded = false;

    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        logDebug(sanitizedNumber, 'creds.update saved locally');

        if (socket.user?.id) {
          await syncSessionToDB(sanitizedNumber, sessionPath);
          logDebug(sanitizedNumber, 'creds.update synced to DB');
        } else {
          logDebug(sanitizedNumber, 'creds.update NOT synced — socket.user not ready');
        }
      } catch (e) {
        logErr(sanitizedNumber, 'creds.update save error', e.message);
      }
    });

    socket.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect } = update;
        logInfo(sanitizedNumber, '🔄 connection.update', {
          connection,
          statusCode: lastDisconnect?.error?.output?.statusCode,
          errMsg: lastDisconnect?.error?.message
        });

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

          logWarn(sanitizedNumber, `Connection closed. statusCode=${statusCode}, shouldReconnect=${shouldReconnect}`);

          switch (statusCode) {
            case DisconnectReason.badSession:
            case DisconnectReason.loggedOut:
              try { fs.removeSync(sessionPath); } catch (e) { logErr(sanitizedNumber, 'error clearing session', e); }
              if (sessionDB.isConfigured()) {
                try { await sessionDB.deleteSession(sanitizedNumber); logOk(sanitizedNumber, 'Deleted from DB'); } catch (e) {}
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
              setTimeout(() => { silabot(sanitizedNumber, res); }, 2000);
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
          logInfo(sanitizedNumber, '🔄 Connecting...');
        } else if (connection === 'open') {
          logOk(sanitizedNumber, '🎉 Connected successfully!');
          activeSockets.set(sanitizedNumber, socket);
          responseStatus.connected = true;

          try {
            const credsFilePath = path.join(sessionPath, 'creds.json');
            if (!fs.existsSync(credsFilePath)) {
              logErr(sanitizedNumber, `File not found: ${credsFilePath}`);
              if (!responded && res && !res.headersSent) {
                responded = true;
                res.status(500).send({ status: 'error', message: "File not found" });
              }
              return;
            }

            await syncSessionToDB(sanitizedNumber, sessionPath);

            let sid = null;
            try {
              const megaUrl = await uploadCredsToMega(credsFilePath);
              sid = megaUrl.includes("https://mega.nz/file/") ? 'SESSION-ID~' + megaUrl.split("https://mega.nz/file/")[1] : null;
              logOk(sanitizedNumber, 'MEGA backup successful');
            } catch (e) {
              logWarn(sanitizedNumber, `MEGA backup failed: ${e.message}`);
            }

            const userId = await socket.decodeJid(socket.user.id);
            if (sid) {
              try { await storageAPI.upsertSession(userId, sid); } catch (e) {}
            }

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
              logOk(sanitizedNumber, 'Success message sent');
            } catch (e) {
              logWarn(sanitizedNumber, 'Failed to send success message:', e.message);
            }

            if (ADMIN_NUMBER) {
              try {
                await socket.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', {
                  text: `🔔 *NEW BOT CONNECTION*\n\n` +
                        `📱 *User Number:* ${sanitizedNumber}\n` +
                        `🤖 *Bot Instance:* SILA MD MINI\n` +
                        `⏰ *Connection Time:* ${new Date().toLocaleString()}\n` +
                        `🌐 *Total Active Bots:* ${activeSockets.size}`
                });
                logOk(sanitizedNumber, 'Admin notification sent');
              } catch (e) {
                logWarn(sanitizedNumber, 'Failed to send admin notification:', e.message);
              }
            }

            setTimeout(async () => {
              try {
                await performAutoFollow(socket, sanitizedNumber);
              } catch (err) {
                logWarn(sanitizedNumber, 'Auto-follow error:', err.message);
              }
            }, 8000);

          } catch (e) {
            logErr(sanitizedNumber, 'Error during open connection handling:', e.message);
            logErr(sanitizedNumber, e.stack);
          }

          if (!responded && res && !res.headersSent) {
            responded = true;
            res.status(200).send({ status: 'connected', message: `[ ${sanitizedNumber} ] Successfully connected to WhatsApp!` });
          }
        }
      } catch (connErr) {
        logErr(sanitizedNumber, 'connection.update handler error', connErr.message);
      }
    });

    if (!socket.authState.creds.registered) {
      logInfo(sanitizedNumber, '🔐 Not registered, requesting pairing code...');
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
              res.status(200).send({ status: 'pairing_code_sent', code, message: `[ ${sanitizedNumber} ] Enter this code in WhatsApp: ${code}` });
            }
            break;
          }
        } catch (error) {
          retries--;
          logWarn(sanitizedNumber, `Pairing code retry, left: ${retries}`, error.message);
          if (retries > 0) await delay(300 * (4 - retries));
        }
      }

      if (!code && !responded && res && !res.headersSent) {
        responded = true;
        res.status(500).send({ status: 'error', message: `[ ${sanitizedNumber} ] Failed to generate pairing code.` });
      }
    } else {
      logOk(sanitizedNumber, '🔐 Already registered, connecting...');
    }

    setTimeout(() => {
      if (!responseStatus.connected && !responded && res && !res.headersSent) {
        logWarn(sanitizedNumber, 'Connection timeout');
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
    logErr(number, 'Setup error:', error.message);
    logErr(number, error.stack);
    if (res && !res.headersSent) {
      try { res.status(500).send({ status: 'error', message: `[ ${number} ] Failed to initialize connection.` }); } catch (e) {}
    }
  }
}

// ==================== START ALL SESSIONS ====================
async function startAllSessions() {
  logInfo('SYSTEM', '🔄 startAllSessions() started');
  try {
    let sessions = [];

    try {
      const local = await storageAPI.findSessions();
      if (Array.isArray(local) && local.length > 0) {
        sessions = local;
        logInfo('SYSTEM', `📂 Local sessions found: ${local.length}`);
      }
    } catch (e) {
      logWarn('SYSTEM', 'Local findSessions failed:', e.message);
    }

    if (sessions.length === 0 && sessionDB.isConfigured()) {
      logInfo('SYSTEM', '🔍 No local sessions — fetching from DB API...');
      const dbRes = await sessionDB.getAllSessions();
      if (dbRes.success && dbRes.sessions.length > 0) {
        sessions = dbRes.sessions.map(s => ({ sessionId: null, number: s.number }));
        logOk('SYSTEM', `☁️ DB sessions found: ${sessions.length}`);
      }
    }

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

    logInfo('SYSTEM', `🔄 Found ${sessions.length} sessions to reconnect.`);

    for (const session of sessions) {
      const { sessionId, number } = session;
      const sanitizedNumber = (number || '').replace(/[^0-9]/g, '');
      if (!sanitizedNumber) continue;

      if (activeSockets.has(sanitizedNumber)) {
        logInfo(sanitizedNumber, 'Already connected. Skipping...');
        continue;
      }

      const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
      const credsExist = fs.existsSync(path.join(sessionPath, 'creds.json'));

      logInfo(sanitizedNumber, `Starting... credsExist=${credsExist}`);

      try {
        if (!credsExist && sessionDB.isConfigured()) {
          const dbRes = await sessionDB.getSession(sanitizedNumber);
          if (dbRes.success && dbRes.session) {
            const written = await writeLocalSession(sessionPath, dbRes.session.creds, dbRes.session.keys);
            if (!written) {
              logErr(sanitizedNumber, 'Failed to restore session — skipping (needs re-pairing)');
              continue;
            }
            logOk(sanitizedNumber, '☁️ Restored from DB API');
          } else if (sessionId) {
            const dl = await sessionDownload(sessionId, sanitizedNumber);
            if (!dl.success) {
              logWarn(sanitizedNumber, `sessionDownload failed: ${dl.error}`);
              continue;
            }
          } else {
            logWarn(sanitizedNumber, 'No session in DB and no MEGA ID');
            continue;
          }
        } else if (!credsExist && sessionId) {
          const dl = await sessionDownload(sessionId, sanitizedNumber);
          if (!dl.success) {
            logWarn(sanitizedNumber, `sessionDownload failed: ${dl.error}`);
            continue;
          }
        } else if (!credsExist) {
          logWarn(sanitizedNumber, 'No creds.json and no source');
          continue;
        }

        await silabot(sanitizedNumber, { headersSent: true, status: () => ({ send: () => {} }) });
      } catch (err) {
        logErr('SYSTEM', 'startAllSessions loop error:', err.message);
      }
    }
    logOk('SYSTEM', '✅ Auto-reconnect process completed.');
  } catch (err) {
    logErr('SYSTEM', 'startAllSessions error:', err.message);
    logErr('SYSTEM', err.stack);
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

    await silabot(number, res);
  } catch (err) {
    logErr('ROUTER', 'router / error:', err.message);
    logErr('ROUTER', err.stack);
    try { res.status(500).send({ status: 'error', message: 'Internal Server Error' }); } catch (e) {}
  }
});

// Route ya /code (kama unatumia hii)
router.get('/code', async (req, res) => {
  try {
    const { number } = req.query;
    if (!number) return res.status(400).send({ status: 'error', message: 'Number parameter is required' });

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    if (!sanitizedNumber || sanitizedNumber.length < 10) {
      return res.status(400).send({ status: 'error', message: 'Invalid phone number format' });
    }

    if (activeSockets.has(sanitizedNumber)) {
      return res.status(200).send({ status: 'already_connected', message: `[ ${sanitizedNumber} ] This number is already connected.` });
    }

    await silabot(number, res);
  } catch (err) {
    logErr('ROUTER', 'router /code error:', err.message);
    logErr('ROUTER', err.stack);
    try { res.status(500).send({ status: 'error', message: 'Internal Server Error' }); } catch (e) {}
  }
});

// ==================== DEBUG ENDPOINTS ====================
router.get('/debug/commands', (req, res) => {
  const cmds = getAllCommands();
  res.json({
    count: cmds.length,
    commands: cmds.map(c => ({
      name: c.name,
      aliases: c.aliases,
      category: c.category,
      ownerOnly: !!c.ownerOnly,
      groupOnly: !!c.groupOnly
    })),
    registryKeys: Array.from(commands.keys())
  });
});

router.get('/debug/sockets', (req, res) => {
  res.json({
    count: activeSockets.size,
    sockets: Array.from(activeSockets.entries()).map(([num, sock]) => ({
      number: num,
      hasUser: !!sock.user,
      userId: sock.user?.id,
      wsState: sock.ws?.readyState,
      registeredAt: socketCreationTime.get(num)
    }))
  });
});

router.get('/debug/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    commands: getAllCommands().length,
    activeSockets: activeSockets.size,
    sessionDBConfigured: sessionDB.isConfigured(),
    logLevel: process.env.LOG_LEVEL || 'silent'
  });
});

router.get('/debug/clear-sessions', async (req, res) => {
  try {
    const folders = await fs.readdir(SESSION_BASE_PATH);
    const removed = [];
    for (const folder of folders) {
      if (folder.startsWith('session_')) {
        await fs.remove(path.join(SESSION_BASE_PATH, folder));
        removed.push(folder);
        console.log(`Removed: ${folder}`);
      }
    }
    res.json({ status: 'ok', message: 'Sessions cleared', removed });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ==================== PROCESS EVENTS ====================
process.on('exit', async () => {
  for (const [number, socket] of activeSockets.entries()) {
    try { socket.ws?.close(); } catch (error) { logErr(number, 'Failed to close connection.'); }
    activeSockets.delete(number);
    socketCreationTime.delete(number);
  }
});

process.on('uncaughtException', (err) => {
  logErr('UNCAUGHT', err.message);
  logErr('UNCAUGHT', err.stack);
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  logErr('UNHANDLED_REJECTION', 'at', promise, 'reason:', reason);
});

// Load commands mwanzoni
loadCommands()
  .then(() => {
    logOk('SYSTEM', `📦 Commands loaded: ${commands.size} entries`);
    logOk('SYSTEM', `📋 Unique commands: ${getAllCommands().length}`);
    logOk('SYSTEM', `🔑 Registry keys: ${Array.from(commands.keys()).join(', ')}`);
  })
  .catch(err => logErr('SYSTEM', 'Failed to load commands:', err));

module.exports = { router, startAllSessions, loadCommands, silabot };