// main.js  (SILA MD MINI - fixed)
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
  downloadContentFromMessage
} = require('@whiskeysockets/baileys');
const yts = require('yt-search');

const storageAPI = require('./file-storage');

/* ───────────── CONFIG ───────────── */
const PREFIX = '.';
const BOT_NAME = 'SILA MD MINI';
const BOT_IMG = 'https://files.catbox.moe/ebj284.jpg'; // used ONLY by menu / alive
const CHANNEL_LINK = 'https://whatsapp.com/channel/0029VbBPxQTJUM2WCZLB6j28';
const NEWSLETTER_JID = '120363402325089913@newsletter';
const NEWSLETTER_NAME = 'SILA MD';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Third-party APIs (badilisha hapa ikiacha kufanya kazi)
const APIS = {
  ytdl: (url, format) => `https://sadiya-tech-apis.vercel.app/download/ytdl?url=${encodeURIComponent(url)}&format=${format}&apikey=sadiya`,
  tiktok: (url) => `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`,
  fb: (url) => `https://api.siputzx.my.id/api/d/fbdl?url=${encodeURIComponent(url)}`,
  insta: (url) => `https://api.siputzx.my.id/api/d/igdl?url=${encodeURIComponent(url)}`,
  aptoide: (q) => `https://ws75.aptoide.com/api/7/apps/search?query=${encodeURIComponent(q)}&limit=1`
};

const OWNER_NUMBERS = (process.env.OWNER_NUMBERS || '255612491554').split(',').filter(Boolean);
const ADMIN_NUMBER = process.env.ADMIN_NUMBER || '255612491554';

const activeSockets = new Map();
const socketCreationTime = new Map();
const reconnecting = new Set();
const SESSION_BASE_PATH = path.resolve(process.env.SESSION_BASE_PATH || './session');

fs.ensureDirSync(SESSION_BASE_PATH);

/* ───────────── HELPERS ───────────── */
function newsletterCtx(sender) {
  return {
    mentionedJid: sender ? [sender] : [],
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
      newsletterJid: NEWSLETTER_JID,
      newsletterName: NEWSLETTER_NAME,
      serverMessageId: 143
    }
  };
}

function digitsOf(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isBotOwner(senderJid, number, fromMe) {
  if (fromMe) return true;
  const s = digitsOf(senderJid);
  if (!s) return false;
  if (s === digitsOf(number)) return true;
  return OWNER_NUMBERS.some(o => s === digitsOf(o) || s.endsWith(digitsOf(o)));
}

function unwrapMessage(m) {
  let cur = m;
  for (let i = 0; i < 5 && cur; i++) {
    const inner =
      cur.ephemeralMessage?.message ||
      cur.viewOnceMessage?.message ||
      cur.viewOnceMessageV2?.message ||
      cur.viewOnceMessageV2Extension?.message ||
      cur.documentWithCaptionMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

function getText(message) {
  if (!message) return '';
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.buttonsResponseMessage?.selectedButtonId ||
    message.listResponseMessage?.singleSelectReply?.selectedRowId ||
    message.templateButtonReplyMessage?.selectedId ||
    ''
  );
}

function getContextInfo(message) {
  if (!message) return null;
  const type = Object.keys(message).find(k => message[k] && typeof message[k] === 'object' && message[k].contextInfo);
  return type ? message[type].contextInfo : null;
}

function getQuotedMedia(message) {
  const ctx = getContextInfo(message);
  const q = unwrapMessage(ctx?.quotedMessage);
  if (!q) return null;
  for (const t of ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage']) {
    if (q[t]) return { type: t.replace('Message', ''), node: q[t] };
  }
  return null;
}

async function downloadMedia(node, type) {
  const stream = await downloadContentFromMessage(node, type);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

function collectUrls(obj, out = []) {
  if (!obj) return out;
  if (typeof obj === 'string') { if (/^https?:\/\//i.test(obj)) out.push(obj); return out; }
  if (Array.isArray(obj)) { obj.forEach(o => collectUrls(o, out)); return out; }
  if (typeof obj === 'object') Object.values(obj).forEach(o => collectUrls(o, out));
  return out;
}

const isImageUrl = (u) => /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u);

async function findYoutubeUrl(q) {
  if (q.includes('youtube.com') || q.includes('youtu.be')) return q;
  const search = await yts(q);
  return search?.videos?.[0]?.url || null;
}

function formatUptime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}h ${m}m ${s}s`;
}

const menuSection = (title, items) =>
  `\`● ${title}\`\n\n╭━━━━━━━━━━━━━━━━━●◌\n` +
  items.map(([c, d]) => `│    \`■ Command :\` ${PREFIX}${c}\n│  *🍃 ${d}*`).join('\n│\n') +
  `\n╰━━━━━━━━━━━━━━━━━●◌`;

/* ───────────── MESSAGE HANDLER ───────────── */
async function kavixmdminibotmessagehandler(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type && type !== 'notify') return;

    for (const msg of messages || []) {
      try {
        if (!msg?.message || msg.key.remoteJid === 'status@broadcast') continue;
        msg.message = unwrapMessage(msg.message);

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith('@g.us');
        const sender = socket.decodeJid(msg.key.participant || msg.key.participantPn || msg.key.senderPn || (msg.key.fromMe ? socket.user.id : from));
        const sanitizedNumber = number.replace(/\D/g, '');
        const isOwner = isBotOwner(sender, number, msg.key.fromMe);

        const body = getText(msg.message).trim();
        if (!body.startsWith(PREFIX)) continue;

        const setting = (await storageAPI.getSettings(number)) || {};
        if (!isOwner) {
          const jidNumber = digitsOf(from);
          switch (setting.worktype) {
            case 'private': if (jidNumber !== sanitizedNumber) continue; break;
            case 'group': if (!isGroup) continue; break;
            case 'inbox': if (isGroup) continue; break;
            default: break;
          }
        }

        const parts = body.slice(PREFIX.length).trim().split(/ +/);
        const command = (parts.shift() || '').toLowerCase();
        const args = parts;
        if (!command) continue;

        const boterr = 'An error has occurred, Please try again.';

        const replygckavi = async (teks) => {
          return socket.sendMessage(from, { text: teks, contextInfo: newsletterCtx(sender) }, { quoted: msg });
        };
        const react = async (emoji) => {
          try { await socket.sendMessage(from, { react: { text: emoji, key: msg.key } }); } catch (e) {}
        };

        const ctxInfo = getContextInfo(msg.message);
        const getTarget = (argIndex = 0) => {
          if (ctxInfo?.mentionedJid?.[0]) return ctxInfo.mentionedJid[0];
          if (ctxInfo?.participant) return ctxInfo.participant;
          const d = (args[argIndex] || '').replace(/\D/g, '');
          return d.length >= 8 ? d + '@s.whatsapp.net' : null;
        };

        try {
          switch (command) {
            /* ───── MENU ───── */
            case 'menu': case 'help': {
              await react('📜');
              const startTime = socketCreationTime.get(sanitizedNumber) || Date.now();
              const uptime = formatUptime(Math.floor((Date.now() - startTime) / 1000));

              const message =
`*SILA MINI BOT  MENU 🤍*

*╭━━━━━━━━━━━━━━━━●◌*
*│ \`● Greet :\`* *Hello 👋*
*│ \`● Bot Name :\`* ${BOT_NAME}
*│ \`● Run Time :\`* ${uptime}
*│ \`● Your Number :\`* ${sanitizedNumber}
*│ \`● Active Bots :\`* ${activeSockets.size}
*╰━━━━━━━━━━━━━━━━●◌*

${menuSection('Download Menu', [
  ['song <jina/link>', 'Download Youtube Songs'],
  ['video <jina/link>', 'Download Youtube Videos'],
  ['csend <jid> <jina>', 'Send Songs To Channels'],
  ['yts <jina>', 'Youtube Search Links'],
  ['tiktok <link>', 'Download Tiktok Videos'],
  ['fb <link>', 'Download Facebook Posts'],
  ['img <jina>', 'Download Images From Web'],
  ['insta <link>', 'Download Instagram Posts'],
  ['mediafire <link>', 'Download Mediafire Files'],
  ['apk <jina>', 'Download Apps (APK)'],
  ['technews', 'Latest World Technews']
])}

${menuSection('User Menu', [
  ['menu', 'Show All Bot Commands'],
  ['alive', 'Check Bot Online / Offline'],
  ['ping', 'Check Bot Run Speed'],
  ['system', 'Show Bot System Info'],
  ['settings', 'Check Bot Settings'],
  ['set <setting> <value>', 'Change Bot Settings (owner)']
])}

${menuSection('Anime Menu', [
  ['anime neko', 'Random Anime Image'],
  ['anime waifu', 'Random Anime Image'],
  ['anime fox_girl', 'Random Anime Image'],
  ['anime hug', 'Random Anime Image'],
  ['anime kiss', 'Random Anime Image'],
  ['anime pat', 'Random Anime Image']
])}

${menuSection('Other Menu', [
  ['fonts <text>', 'Different Types Of Fonts'],
  ['npm <jina>', 'Search Npm Packages'],
  ['reacts', 'Channel React Categories'],
  ['channelinfo <link>', 'Show Channel Details'],
  ['bomb <idadi> <text>', 'Send Message In Any Count (owner)'],
  ['jid', 'Get Chat Jid'],
  ['save', 'Save Status / Media (reply)'],
  ['getpp [@user]', 'Download WhatsApp Profile Photo'],
  ['vv', 'Open ViewOnce Media (reply)'],
  ['group <info/promote/demote/kick>', 'Group Tools (owner)'],
  ['autoreply <add/list/remove>', 'Auto Reply (owner)'],
  ['freebot', 'Connect Our Bot To Your WhatsApp']
])}

> *- 𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 𝚂𝙸𝙻𝙰 𝙼𝙳 𝙼𝙸𝙽𝙸 -*`;

              await socket.sendMessage(from, {
                image: { url: BOT_IMG },
                caption: message,
                contextInfo: newsletterCtx(sender)
              }, { quoted: msg });
              break;
            }

            /* ───── ALIVE ───── */
            case 'alive': {
              await react('💚');
              const startTime = socketCreationTime.get(sanitizedNumber) || Date.now();
              const uptime = formatUptime(Math.floor((Date.now() - startTime) / 1000));
              const aliveMsg =
`🤖 *${BOT_NAME} IS ALIVE* 💚

╭━━━━━━━━━━━━━━━━●◌
│ *Status:* ✅ Online
│ *Uptime:* ${uptime}
│ *User:* ${sanitizedNumber}
│ *Version:* 2.0.0
╰━━━━━━━━━━━━━━━━●◌

> _Bot is running smoothly_`;
              await socket.sendMessage(from, { image: { url: BOT_IMG }, caption: aliveMsg, contextInfo: newsletterCtx(sender) }, { quoted: msg });
              break;
            }

            /* ───── PING ───── */
            case 'ping': {
              await react('🏓');
              const start = Date.now();
              const pingMsg = await socket.sendMessage(from, { text: '🏓 Pinging...' }, { quoted: msg });
              const ping = Date.now() - start;
              await socket.sendMessage(from, { text: `🏓 Pong! ${ping}ms`, edit: pingMsg.key });
              break;
            }

            /* ───── SYSTEM ───── */
            case 'system': {
              await react('💻');
              const totalMem = os.totalmem() / (1024 ** 3);
              const freeMem = os.freemem() / (1024 ** 3);
              const cpus = os.cpus() || [];
              const systemMsg =
`💻 *SYSTEM INFORMATION*

╭━━━━━━━━━━━━━━━━●◌
│ *OS:* ${os.type()} ${os.release()}
│ *Arch:* ${os.arch()}
│ *Platform:* ${os.platform()}
│ *CPU:* ${cpus[0]?.model || 'Unknown'}
│ *Cores:* ${cpus.length}
│ *Memory:* ${(totalMem - freeMem).toFixed(2)}GB / ${totalMem.toFixed(2)}GB
│ *Uptime:* ${formatUptime(Math.floor(process.uptime()))}
│ *Node.js:* ${process.version}
╰━━━━━━━━━━━━━━━━●◌`;
              await replygckavi(systemMsg);
              break;
            }

            /* ───── SONG ───── */
            case 'song': case 'yta': case 'play': {
              await react('🎵');
              const q = args.join(' ');
              if (!q) return await replygckavi('🚫 Please provide a search query.');

              const ytUrl = await findYoutubeUrl(q);
              if (!ytUrl) return await replygckavi('🚫 No results found.');

              const { data: apiRes } = await axios.get(APIS.ytdl(ytUrl, 'mp3'), { timeout: 30000 });
              if (!apiRes?.status || !apiRes.result?.download) return await replygckavi('🚫 Something went wrong.');

              const r = apiRes.result;
              const caption = `*🎵 SONG DOWNLOADED*\n\n*ℹ️ Title :* \`${r.title}\`\n*⏱️ Duration :* \`${r.duration}\`\n*🧬 Views :* \`${r.views}\`\n📅 *Released Date :* \`${r.publish}\`\n\n_Tumia ${PREFIX}video ${r.title} kupata video_`;

              if (r.thumbnail) await socket.sendMessage(from, { image: { url: r.thumbnail }, caption, contextInfo: newsletterCtx(sender) }, { quoted: msg });
              else await replygckavi(caption);
              await socket.sendMessage(from, { audio: { url: r.download }, mimetype: 'audio/mpeg', fileName: `${r.title}.mp3`, ptt: false }, { quoted: msg });
              break;
            }

            /* ───── VIDEO ───── */
            case 'video': case 'ytv': {
              await react('🎥');
              const q = args.join(' ');
              if (!q) return await replygckavi('🚫 Please provide a search query.');

              const ytUrl = await findYoutubeUrl(q);
              if (!ytUrl) return await replygckavi('🚫 No results found.');

              const { data: apiRes } = await axios.get(APIS.ytdl(ytUrl, 'mp4'), { timeout: 40000 });
              if (!apiRes?.status || !apiRes.result?.download) return await replygckavi('🚫 Something went wrong.');

              const r = apiRes.result;
              const caption = `*🎥 VIDEO DOWNLOADED*\n\n*ℹ️ Title :* \`${r.title}\`\n*⏱️ Duration :* \`${r.duration}\`\n*🧬 Views :* \`${r.views}\`\n📅 *Released Date :* \`${r.publish}\``;
              await socket.sendMessage(from, { video: { url: r.download }, caption, mimetype: 'video/mp4' }, { quoted: msg });
              break;
            }

            /* ───── CSEND (send song to channel/jid) ───── */
            case 'csend': {
              if (!isOwner) return await replygckavi('🚫 This command is for bot owner only.');
              const targetJid = args[0];
              const q = args.slice(1).join(' ');
              if (!targetJid || !q || !/@(newsletter|g\.us|s\.whatsapp\.net)$/.test(targetJid)) {
                return await replygckavi(`🚫 Usage: ${PREFIX}csend <jid> <song name>\nMfano: ${PREFIX}csend 120363xxxx@newsletter Alan Walker Faded`);
              }
              await react('📤');
              const ytUrl = await findYoutubeUrl(q);
              if (!ytUrl) return await replygckavi('🚫 No results found.');
              const { data: apiRes } = await axios.get(APIS.ytdl(ytUrl, 'mp3'), { timeout: 30000 });
              if (!apiRes?.status || !apiRes.result?.download) return await replygckavi('🚫 Something went wrong.');
              const r = apiRes.result;
              if (r.thumbnail) await socket.sendMessage(targetJid, { image: { url: r.thumbnail }, caption: `*🎵 ${r.title}*\n⏱️ ${r.duration}` });
              await socket.sendMessage(targetJid, { audio: { url: r.download }, mimetype: 'audio/mpeg', ptt: false });
              await replygckavi(`✅ Sent *${r.title}* to ${targetJid}`);
              break;
            }

            /* ───── YTS ───── */
            case 'yts': {
              await react('🔎');
              const q = args.join(' ');
              if (!q) return await replygckavi('🚫 Please provide a search query.');
              const search = await yts(q);
              const list = (search?.videos || []).slice(0, 8);
              if (!list.length) return await replygckavi('🚫 No results found.');
              const txt = `*🔎 YOUTUBE SEARCH*\n_${q}_\n\n` + list.map((v, i) =>
                `*${i + 1}. ${v.title}*\n⏱️ ${v.timestamp} | 👁️ ${v.views?.toLocaleString?.() || v.views}\n🔗 ${v.url}`).join('\n\n');
              await replygckavi(txt);
              break;
            }

            /* ───── TIKTOK ───── */
            case 'tiktok': case 'tt': {
              await react('📱');
              const url = args[0];
              if (!url) return await replygckavi('🚫 Please provide a TikTok URL.');
              const { data } = await axios.get(APIS.tiktok(url), { timeout: 30000, headers: { 'User-Agent': UA } });
              const d = data?.data;
              if (!d) return await replygckavi('🚫 Failed to fetch TikTok video.');
              let vid = d.hdplay || d.play;
              if (vid && vid.startsWith('/')) vid = 'https://www.tikwm.com' + vid;
              if (!vid) return await replygckavi('🚫 No video found.');
              const cap = `*📱 TIKTOK DOWNLOADER*\n\n*👤 Author:* ${d.author?.nickname || 'Unknown'}\n*📝 Title:* ${d.title || '-'}`;
              await socket.sendMessage(from, { video: { url: vid }, caption: cap, mimetype: 'video/mp4' }, { quoted: msg });
              break;
            }

            /* ───── FACEBOOK / INSTAGRAM ───── */
            case 'fb': case 'insta': {
              await react(command === 'fb' ? '📘' : '📸');
              const url = args[0];
              if (!url) return await replygckavi(`🚫 Please provide a ${command === 'fb' ? 'Facebook' : 'Instagram'} URL.`);
              const api = command === 'fb' ? APIS.fb(url) : APIS.insta(url);
              const { data } = await axios.get(api, { timeout: 40000, headers: { 'User-Agent': UA } });
              const urls = [...new Set(collectUrls(data))].filter(u => !/(thumbnail|\.html?$)/i.test(u));
              if (!urls.length) return await replygckavi('🚫 No media found. Hakikisha link ni public.');
              const media = urls.slice(0, 3);
              for (const u of media) {
                if (isImageUrl(u)) await socket.sendMessage(from, { image: { url: u } }, { quoted: msg });
                else await socket.sendMessage(from, { video: { url: u }, mimetype: 'video/mp4' }, { quoted: msg });
              }
              break;
            }

            /* ───── IMG (Bing images) ───── */
            case 'img': case 'image': {
              await react('🖼️');
              const q = args.join(' ');
              if (!q) return await replygckavi('🚫 Please provide a search query.');
              const { data: html } = await axios.get(`https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2`, { headers: { 'User-Agent': UA }, timeout: 20000 });
              const found = [...String(html).matchAll(/murl&quot;:&quot;(.*?)&quot;/g)].map(m => m[1]).filter(u => /^https?:\/\//.test(u) && isImageUrl(u));
              if (!found.length) return await replygckavi('🚫 No images found.');
              let sent = 0;
              for (const u of found) {
                if (sent >= 3) break;
                try {
                  await socket.sendMessage(from, { image: { url: u }, caption: sent === 0 ? `*🖼️ ${q}*` : '' }, { quoted: msg });
                  sent++;
                } catch (e) {}
              }
              if (!sent) await replygckavi('🚫 Failed to send images.');
              break;
            }

            /* ───── MEDIAFIRE ───── */
            case 'mediafire': case 'mf': {
              await react('📁');
              const url = args[0];
              if (!url || !url.includes('mediafire.com')) return await replygckavi('🚫 Please provide a valid Mediafire URL.');
              const { data: html } = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 30000 });
              const h = String(html);
              const link =
                h.match(/aria-label="Download file"[^>]*href="([^"]+)"/)?.[1] ||
                h.match(/href="((?:https?:)?\/\/download[^"]+)"/)?.[1];
              if (!link) return await replygckavi('🚫 Could not find the download link.');
              const finalLink = link.startsWith('//') ? 'https:' + link : link;
              const fileName = decodeURIComponent(finalLink.split('/').pop().split('?')[0]) || 'file';
              await replygckavi(`*📁 MEDIAFIRE*\n\n*Name:* ${fileName}\n\n_Inatuma faili..._`);
              await socket.sendMessage(from, { document: { url: finalLink }, fileName, mimetype: 'application/octet-stream' }, { quoted: msg });
              break;
            }

            /* ───── APK (Aptoide) ───── */
            case 'apk': {
              await react('📦');
              const q = args.join(' ');
              if (!q) return await replygckavi('🚫 Please provide an app name.');
              const { data } = await axios.get(APIS.aptoide(q), { timeout: 30000 });
              const app = data?.datalist?.list?.[0];
              if (!app?.file?.path) return await replygckavi('🚫 App not found.');
              const sizeMB = (app.size / (1024 * 1024)).toFixed(2);
              await replygckavi(`*📦 APK DOWNLOADER*\n\n*Name:* ${app.name}\n*Package:* ${app.package}\n*Version:* ${app.file?.vername || '-'}\n*Size:* ${sizeMB} MB\n\n_Inatuma faili..._`);
              await socket.sendMessage(from, {
                document: { url: app.file.path },
                fileName: `${app.name}.apk`,
                mimetype: 'application/vnd.android.package-archive'
              }, { quoted: msg });
              break;
            }

            /* ───── TECHNEWS (Hacker News) ───── */
            case 'technews': {
              await react('📰');
              const { data: ids } = await axios.get('https://hacker-news.firebaseio.com/v0/topstories.json', { timeout: 20000 });
              const items = await Promise.all(ids.slice(0, 6).map(id =>
                axios.get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, { timeout: 20000 }).then(r => r.data).catch(() => null)));
              const news = items.filter(i => i?.title);
              if (!news.length) return await replygckavi('🚫 Could not fetch news.');
              const txt = `*📰 LATEST TECH NEWS*\n\n` + news.map((n, i) =>
                `*${i + 1}. ${n.title}*\n🔗 ${n.url || `https://news.ycombinator.com/item?id=${n.id}`}`).join('\n\n');
              await replygckavi(txt);
              break;
            }

            /* ───── ANIME ───── */
            case 'anime': {
              await react('🎌');
              const type = (args[0] || 'neko').toLowerCase();
              const validTypes = ['neko', 'waifu', 'fox_girl', 'hug', 'kiss', 'pat'];
              if (!validTypes.includes(type)) return await replygckavi(`🚫 Invalid anime type. Available: ${validTypes.join(', ')}`);

              let imgUrl;
              if (type === 'fox_girl') {
                const { data } = await axios.get('https://nekos.best/api/v2/kitsune', { timeout: 20000 });
                imgUrl = data?.results?.[0]?.url;
              } else {
                const { data } = await axios.get(`https://api.waifu.pics/sfw/${type}`, { timeout: 20000 });
                imgUrl = data?.url;
              }
              if (!imgUrl) return await replygckavi('🚫 Failed to fetch anime image.');
              await socket.sendMessage(from, { image: { url: imgUrl }, caption: `*🎌 ANIME ${type.toUpperCase()}*` }, { quoted: msg });
              break;
            }

            /* ───── FONTS ───── */
            case 'fonts': {
              await react('🔤');
              const t = args.join(' ');
              if (!t) return await replygckavi('🚫 Please provide text.');
              await replygckavi(
                `🔤 *FONT STYLES*\n\n` +
                `*Bold:* *${t}*\n*Italic:* _${t}_\n*Mono:* \`\`\`${t}\`\`\`\n*Strike:* ~${t}~\n*Small:* 〔 ${t} 〕\n*Fancy:* 「 ${t} 」`
              );
              break;
            }

            /* ───── NPM ───── */
            case 'npm': {
              await react('📦');
              const q = args.join(' ');
              if (!q) return await replygckavi('🚫 Please provide a package name.');
              const { data } = await axios.get(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=5`, { timeout: 20000 });
              const objs = data?.objects || [];
              if (!objs.length) return await replygckavi('🚫 No packages found.');
              const txt = `*📦 NPM SEARCH*\n_${q}_\n\n` + objs.map((o, i) => {
                const p = o.package;
                return `*${i + 1}. ${p.name}* (v${p.version})\n${p.description || 'No description'}\n🔗 ${p.links?.npm || `https://www.npmjs.com/package/${p.name}`}`;
              }).join('\n\n');
              await replygckavi(txt);
              break;
            }

            /* ───── REACTS ───── */
            case 'reacts': {
              await react('😀');
              await replygckavi(
`*😀 CHANNEL REACT CATEGORIES*

*❤️ Love:* ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 😍 🥰
*😂 Funny:* 😂 🤣 😹 😆 😜 🤪
*🔥 Hype:* 🔥 💯 🚀 ⚡ 🎉 👏 🙌
*😢 Sad:* 😢 😭 💔 🥺 😞
*😮 Surprise:* 😮 😱 🤯 😲
*👍 Support:* 👍 🙏 💪 ✅ 🤝`);
              break;
            }

            /* ───── CHANNEL INFO ───── */
            case 'channelinfo': case 'cinfo': {
              await react('📢');
              const link = args[0] || '';
              const code = link.match(/channel\/([A-Za-z0-9_-]+)/)?.[1];
              if (!code) return await replygckavi(`🚫 Usage: ${PREFIX}channelinfo https://whatsapp.com/channel/xxxx`);
              const meta = await socket.newsletterMetadata('invite', code);
              if (!meta) return await replygckavi('🚫 Channel not found.');
              const tm = meta.thread_metadata || {};
              const name = tm.name?.text || meta.name || 'Unknown';
              const desc = tm.description?.text || meta.description || 'No description';
              const subs = tm.subscribers_count || meta.subscribers || 'Unknown';
              await replygckavi(`*📢 CHANNEL INFO*\n\n*Name:* ${name}\n*JID:* ${meta.id}\n*Followers:* ${subs}\n*Description:* ${desc}`);
              break;
            }

            /* ───── BOMB ───── */
            case 'bomb': {
              if (!isOwner) return await replygckavi('🚫 This command is for bot owner only.');
              const count = parseInt(args[0], 10);
              const text = args.slice(1).join(' ');
              if (!count || !text) return await replygckavi(`🚫 Usage: ${PREFIX}bomb <idadi> <text>\nMax: 20`);
              const n = Math.min(count, 20);
              for (let i = 0; i < n; i++) {
                await socket.sendMessage(from, { text });
                await delay(700);
              }
              break;
            }

            /* ───── JID ───── */
            case 'jid': {
              await react('🆔');
              await replygckavi(`🆔 *CHAT JID*\n\n\`${from}\``);
              break;
            }

            /* ───── SAVE / VV ───── */
            case 'save': case 'vv': case 'viewonce': {
              await react(command === 'save' ? '💾' : '👀');
              const media = getQuotedMedia(msg.message);
              if (!media) return await replygckavi(`🚫 Reply kwenye ${command === 'save' ? 'status/media' : 'view once'} kisha tuma ${PREFIX}${command}`);
              const buffer = await downloadMedia(media.node, media.type);
              const caption = media.node.caption || '';
              const dest = command === 'save' && isOwner ? socket.decodeJid(socket.user.id) : from;
              if (media.type === 'image') await socket.sendMessage(dest, { image: buffer, caption }, { quoted: msg });
              else if (media.type === 'video') await socket.sendMessage(dest, { video: buffer, caption }, { quoted: msg });
              else if (media.type === 'audio') await socket.sendMessage(dest, { audio: buffer, mimetype: media.node.mimetype || 'audio/mpeg', ptt: !!media.node.ptt }, { quoted: msg });
              else if (media.type === 'sticker') await socket.sendMessage(dest, { sticker: buffer }, { quoted: msg });
              else await socket.sendMessage(dest, { document: buffer, fileName: media.node.fileName || 'file', mimetype: media.node.mimetype || 'application/octet-stream' }, { quoted: msg });
              if (dest !== from) await replygckavi('✅ Saved to your chat.');
              break;
            }

            /* ───── GETPP ───── */
            case 'getpp': {
              await react('🖼️');
              const target = getTarget(0) || (isGroup ? sender : from);
              let url;
              try { url = await socket.profilePictureUrl(target, 'image'); } catch (e) {}
              if (!url) return await replygckavi('🚫 User has no profile photo (au imefichwa).');
              await socket.sendMessage(from, { image: { url }, caption: `*🖼️ PROFILE PHOTO*\n@${digitsOf(target)}`, mentions: [target] }, { quoted: msg });
              break;
            }

            /* ───── SETTINGS ───── */
            case 'settings': {
              await react('⚙️');
              const s = (await storageAPI.getSettings(sanitizedNumber)) || {};
              await replygckavi(
                `⚙️ *BOT SETTINGS*\n\n` +
                `*Work Type:* ${s.worktype || 'public'}\n` +
                `*Auto Read:* ${s.autoread ? '✅' : '❌'}\n` +
                `*Online Presence:* ${s.online ? '✅' : '❌'}\n` +
                `*Auto Status View:* ${s.autoswview ? '✅' : '❌'}\n` +
                `*Auto Status Like:* ${s.autoswlike ? '✅' : '❌'}\n\n` +
                `*Change settings:*\n` +
                `${PREFIX}set worktype [public/private/group/inbox]\n` +
                `${PREFIX}set autoread [on/off]\n` +
                `${PREFIX}set online [on/off]\n` +
                `${PREFIX}set autoswview [on/off]\n` +
                `${PREFIX}set autoswlike [on/off]`
              );
              break;
            }

            case 'set': {
              if (!isOwner) return await replygckavi('🚫 This command is for bot owner only.');
              await react('🔧');
              const key = (args[0] || '').toLowerCase();
              const value = (args[1] || '').toLowerCase();
              if (!key || !value) return await replygckavi(`🚫 Usage: ${PREFIX}set [setting] [value]\n\nAvailable: worktype, autoread, online, autoswview, autoswlike`);

              const s = (await storageAPI.getSettings(sanitizedNumber)) || {};
              let updated = false;
              if (key === 'worktype') {
                if (['public', 'private', 'group', 'inbox'].includes(value)) { s.worktype = value; updated = true; }
              } else if (['autoread', 'online', 'autoswview', 'autoswlike'].includes(key)) {
                if (['on', 'off'].includes(value)) { s[key] = value === 'on'; updated = true; }
              }
              if (!updated) return await replygckavi('🚫 Invalid setting or value.');
              await storageAPI.saveSettings(sanitizedNumber, s);
              await replygckavi(`✅ Setting updated:\n*${key}* → *${value}*`);
              break;
            }

            /* ───── GROUP ───── */
            case 'group': {
              if (!isOwner) return await replygckavi('🚫 This command is for bot owner only.');
              if (!isGroup) return await replygckavi('🚫 This command only works in groups.');
              await react('👥');
              const sub = (args[0] || '').toLowerCase();

              if (sub === 'info') {
                const metadata = await socket.groupMetadata(from);
                await replygckavi(
                  `👥 *GROUP INFO*\n\n` +
                  `*Name:* ${metadata.subject}\n*ID:* ${metadata.id}\n*Participants:* ${metadata.participants.length}\n` +
                  `*Creation:* ${new Date(metadata.creation * 1000).toLocaleDateString()}\n` +
                  `*Owner:* ${metadata.owner ? digitsOf(metadata.owner) : 'Unknown'}\n` +
                  `*Description:* ${metadata.desc || 'No description'}`
                );
              } else if (['promote', 'demote', 'kick'].includes(sub)) {
                const target = getTarget(1);
                if (!target) return await replygckavi(`🚫 Tag mtu, reply ujumbe wake, au andika namba.\nMfano: ${PREFIX}group ${sub} @user`);
                const action = sub === 'kick' ? 'remove' : sub;
                await socket.groupParticipantsUpdate(from, [target], action);
                await replygckavi(`✅ ${sub} done: ${digitsOf(target)}`);
              } else {
                await replygckavi(`🚫 Available group commands:\n• ${PREFIX}group info\n• ${PREFIX}group promote [@user]\n• ${PREFIX}group demote [@user]\n• ${PREFIX}group kick [@user]`);
              }
              break;
            }

            /* ───── AUTOREPLY ───── */
            case 'autoreply': {
              if (!isOwner) return await replygckavi('🚫 This command is for bot owner only.');
              await react('🤖');
              const sub = (args[0] || '').toLowerCase();
              const s = (await storageAPI.getSettings(sanitizedNumber)) || {};
              s.autoreplies = s.autoreplies || {};

              if (sub === 'add') {
                if (args.length < 3) return await replygckavi(`🚫 Usage: ${PREFIX}autoreply add [trigger] [response]`);
                const trigger = args[1].toLowerCase();
                s.autoreplies[trigger] = args.slice(2).join(' ');
                await storageAPI.saveSettings(sanitizedNumber, s);
                await replygckavi(`✅ Auto-reply added:\nTrigger: ${trigger}\nResponse: ${s.autoreplies[trigger]}`);
              } else if (sub === 'list') {
                const entries = Object.entries(s.autoreplies);
                if (!entries.length) return await replygckavi('📭 Hakuna auto-reply bado.');
                await replygckavi(`*🤖 AUTO-REPLIES*\n\n` + entries.map(([k, v]) => `• *${k}* → ${v}`).join('\n'));
              } else if (sub === 'remove') {
                const trigger = (args[1] || '').toLowerCase();
                if (!trigger || !s.autoreplies[trigger]) return await replygckavi('🚫 Trigger not found.');
                delete s.autoreplies[trigger];
                await storageAPI.saveSettings(sanitizedNumber, s);
                await replygckavi(`✅ Removed: ${trigger}`);
              } else {
                await replygckavi(`🚫 Available auto-reply commands:\n• ${PREFIX}autoreply add [trigger] [response]\n• ${PREFIX}autoreply list\n• ${PREFIX}autoreply remove [trigger]`);
              }
              break;
            }

            /* ───── FREEBOT ───── */
            case 'freebot': {
              await react('🤖');
              await replygckavi(
                `🤖 *CONNECT FREE BOT*\n\n` +
                `To connect ${BOT_NAME} to your WhatsApp:\n\n` +
                `1. Visit our website https://min-bot-ewan.onrender.com\n` +
                `2. Enter your number and get the pairing code\n` +
                `3. Link it in WhatsApp > Linked Devices\n\n` +
                `*Features:*\n✅ YouTube Downloader\n✅ TikTok Downloader\n✅ Facebook / Instagram Downloader\n` +
                `✅ Anime Images\n✅ Group Management\n✅ Auto-reply System\n\n_Contact admin for more info_`
              );
              break;
            }

            default:
              await replygckavi(`🚫 Unknown command: ${command}\nUse *${PREFIX}menu* to see all commands.`);
          }
        } catch (err) {
          console.error(`Command "${command}" error:`, err?.message || err);
          try { await replygckavi(`🚫 ${boterr}`); } catch (e) {}
        }
      } catch (outerErr) {
        console.error('messages.upsert handler error:', outerErr);
      }
    }
  });
}

/* ───────────── STATUS / AUTO HANDLER ───────────── */
async function kavixmdminibotstatushandler(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type && type !== 'notify') return;

    for (const msg of messages || []) {
      try {
        if (!msg || !msg.message) continue;
        const sender = msg.key.remoteJid;
        const settings = await storageAPI.getSettings(number);
        if (!settings) continue;

        if (sender === 'status@broadcast') {
          if (settings.autoswview) { try { await socket.readMessages([msg.key]); } catch (e) {} }
          if (settings.autoswlike && !msg.key.fromMe) {
            try {
              const emojis = ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔'];
              const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
              await socket.sendMessage(sender, { react: { key: msg.key, text: randomEmoji } }, { statusJidList: [msg.key.participant, socket.decodeJid(socket.user.id)] });
            } catch (e) {}
          }
          continue;
        }

        if (msg.key.fromMe) continue;

        if (settings.autoread) { try { await socket.readMessages([msg.key]); } catch (e) {} }

        try {
          await socket.sendPresenceUpdate(settings.online ? 'available' : 'unavailable', sender);
        } catch (e) {}

        // Auto-reply (private chats only)
        if (sender.endsWith('@g.us')) continue;
        const content = getText(unwrapMessage(msg.message)).trim();
        if (!content || content.startsWith(PREFIX)) continue;

        const autoReplies = {
          hi: 'Hello! 👋 How can I help you?',
          hello: `Hi there! 😊 Use ${PREFIX}menu to see all commands.`,
          bot: `Yes, I'm ${BOT_NAME}! 🤖 How can I assist you?`,
          ...(settings.autoreplies || {})
        };
        const reply = autoReplies[content.toLowerCase()];
        if (reply) {
          await socket.sendMessage(sender, { text: reply, contextInfo: newsletterCtx(msg.key.participant || sender) }, { quoted: msg });
        }
      } catch (err) {
        console.error('status handler error:', err);
      }
    }
  });
}

/* ───────────── SESSION DOWNLOAD / MEGA ───────────── */
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
          downloadStream.on('error', reject);
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
  const num = Math.floor(Math.random() * Math.pow(10, numberLength));
  return `${result}${num}`;
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

/* ───────────── CORE ───────────── */
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
      }
      return jid;
    };

    socketCreationTime.set(sanitizedNumber, Date.now());

    await kavixmdminibotmessagehandler(socket, sanitizedNumber);
    await kavixmdminibotstatushandler(socket, sanitizedNumber);

    const responseStatus = { codeSent: false, connected: false, error: null };
    let responded = false;

    socket.ev.on('creds.update', async () => {
      try { await saveCreds(); } catch (e) { console.error('creds.update save error', e); }
    });

    socket.ev.on('connection.update', async (update) => {
      try {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession;

          if (loggedOut) {
            try { fs.removeSync(sessionPath); } catch (e) { console.error('error clearing session', e); }
            responseStatus.error = 'Session invalid or logged out. Please pair again.';
          } else if (statusCode === DisconnectReason.connectionReplaced) {
            responseStatus.error = 'Connection replaced by another session';
          } else {
            responseStatus.error = 'Connection closed. Reconnecting...';
          }

          activeSockets.delete(sanitizedNumber);
          socketCreationTime.delete(sanitizedNumber);
          try { socket.ws?.close(); } catch (e) {}

          // Auto reconnect for registered sessions
          const registered = !!socket.authState?.creds?.registered;
          if (!loggedOut && statusCode !== DisconnectReason.connectionReplaced && registered && !reconnecting.has(sanitizedNumber)) {
            reconnecting.add(sanitizedNumber);
            setTimeout(() => {
              reconnecting.delete(sanitizedNumber);
              cyberkaviminibot(sanitizedNumber, null).catch(e => console.error('reconnect error', e));
            }, 3000);
          }

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
              console.error('File not found:', credsFilePath);
              if (!responded && res && !res.headersSent) {
                responded = true;
                res.status(500).send({ status: 'error', message: 'File not found' });
              }
              return;
            }

            const userId = socket.decodeJid(socket.user.id);

            // Upload creds only when a fresh pairing happened (res present)
            if (res) {
              try {
                const megaUrl = await uploadCredsToMega(credsFilePath);
                const sid = megaUrl.includes('https://mega.nz/file/') ? 'SESSION-ID~' + megaUrl.split('https://mega.nz/file/')[1] : null;
                if (sid) await storageAPI.upsertSession(userId, sid);
              } catch (e) {
                console.error('Mega upload error:', e.message);
              }
            }

            try {
              await socket.sendMessage(userId, {
                text:
                  `✅ *${BOT_NAME} CONNECTED*\n\n` +
                  `🤖 *Bot Name:* ${BOT_NAME}\n` +
                  `📱 *Your Number:* ${sanitizedNumber}\n` +
                  `⏰ *Connected At:* ${new Date().toLocaleString()}\n\n` +
                  `Use *${PREFIX}menu* to see all commands!\n\n` +
                  `_Join our channel for updates:_\n${CHANNEL_LINK}`,
                contextInfo: newsletterCtx(userId)
              });
            } catch (e) {}

            if (res && ADMIN_NUMBER) {
              try {
                await socket.sendMessage(ADMIN_NUMBER + '@s.whatsapp.net', {
                  text:
                    `🔔 *NEW BOT CONNECTION*\n\n` +
                    `📱 *User Number:* ${sanitizedNumber}\n` +
                    `🤖 *Bot Instance:* ${BOT_NAME}\n` +
                    `⏰ *Connection Time:* ${new Date().toLocaleString()}\n` +
                    `🌐 *Total Active Bots:* ${activeSockets.size}`
                });
              } catch (e) {
                console.error('Failed to send admin notification:', e.message);
              }
            }

            // Auto-follow channels
            const channels = ['120363422610520277@newsletter', NEWSLETTER_JID];
            for (const channel of channels) {
              try {
                const metadata = await socket.newsletterMetadata('jid', channel);
                if (!metadata?.viewer_metadata) {
                  await socket.newsletterFollow(channel);
                  console.log(`[ ${sanitizedNumber} ] Auto-followed channel: ${channel}`);
                }
              } catch (err) {
                console.warn(`[ ${sanitizedNumber} ] Failed to follow channel ${channel}:`, err.message);
              }
            }
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

    if (res) {
      setTimeout(() => {
        if (!responseStatus.connected && !responded && !res.headersSent) {
          responded = true;
          res.status(408).send({ status: 'timeout', message: `[ ${sanitizedNumber} ] Connection timeout. Please try again.` });
          if (activeSockets.has(sanitizedNumber)) {
            try { activeSockets.get(sanitizedNumber).ws?.close(); } catch (e) {}
            activeSockets.delete(sanitizedNumber);
          }
          socketCreationTime.delete(sanitizedNumber);
        }
      }, Number(process.env.CONNECT_TIMEOUT_MS || 60000));
    }
  } catch (error) {
    console.error(`[ ${number} ] Setup error:`, error);
    if (res && !res.headersSent) {
      try { res.status(500).send({ status: 'error', message: `[ ${number} ] Failed to initialize connection.` }); } catch (e) {}
    }
  }
}

/* ───────────── START ALL SESSIONS ───────────── */
async function startAllSessions() {
  try {
    const sessions = await storageAPI.findSessions();
    console.log(`🔄 Found ${sessions.length} sessions to reconnect.`);

    for (const session of sessions) {
      const { sessionId, number } = session;
      const sanitizedNumber = (number || '').replace(/[^0-9]/g, '');
      if (!sanitizedNumber) continue;
      if (activeSockets.has(sanitizedNumber)) {
        console.log(`[ ${sanitizedNumber} ] Already connected. Skipping...`);
        continue;
      }
      try {
        const dl = await sessionDownload(sessionId, sanitizedNumber);
        if (!dl.success) {
          console.warn(`[ ${sanitizedNumber} ] sessionDownload failed: ${dl.error}`);
          continue;
        }
        await cyberkaviminibot(sanitizedNumber, null);
      } catch (err) {
        console.error('startAllSessions error', err);
      }
    }
    console.log('✅ Auto-reconnect process completed.');
  } catch (err) {
    console.error('startAllSessions error', err);
  }
}

/* ───────────── ROUTER ───────────── */
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

/* ───────────── PROCESS EVENTS ───────────── */
process.on('exit', () => {
  for (const [number, socket] of activeSockets.entries()) {
    try { socket.ws?.close(); } catch (error) { console.error(`[ ${number} ] Failed to close connection.`); }
    activeSockets.delete(number);
    socketCreationTime.delete(number);
  }
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = { router, startAllSessions };
