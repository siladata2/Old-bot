module.exports = {
  name: 'menu',
  aliases: ['help', 'h'],
  category: 'user',
  async execute(ctx) {
    const { socket, msg, number, botImg, os, activeSockets, socketCreationTime } = ctx;

    await socket.sendMessage(msg.key.remoteJid, { react: { text: "📜", key: msg.key }}, { quoted: msg });

    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const totalMemMB = (os.totalmem() / (1024 * 1024)).toFixed(2);
    const freeMemMB = (os.freemem() / (1024 * 1024)).toFixed(2);
    const activeBots = activeSockets.size;

    const message = `*╭━━━━━━━━━━━━━━━━●◌*
*│  SILA MD MINI BOT 🤍*
*╰━━━━━━━━━━━━━━━━●◌*

*╭━━━━━━━━━━━━━━━━●◌*
*│ ● Greet :* Hello 👋
*│ ● Bot Name :* SILA MD MINI
*│ ● Owner :* Sila Tech
*│ ● Owner No :* 255789661031
*│ ● Run Time :* ${hours}h ${minutes}m ${seconds}s
*│ ● Your Number :* ${number}
*│ ● Active Bots :* ${activeBots}
*│ ● RAM Used :* ${freeMemMB}MB / ${totalMemMB}MB
*╰━━━━━━━━━━━━━━━━●◌*

*┏━━━━━━━━━━━━━━━━━●◌*
*┃    📥 DOWNLOAD MENU*
*┗━━━━━━━━━━━━━━━━━●◌*
*┃ ■ .song*  
*┃ ■ .video* 
*┃ ■ .tiktok*
*┃ ■ .fb*    
*┃ ■ .img*   
*┃ ■ .insta* 
*┗━━━━━━━━━━━━━━━━━●◌*

*┏━━━━━━━━━━━━━━━━━●◌*
*┃    👤 USER MENU*
*┗━━━━━━━━━━━━━━━━━●◌*
*┃ ■ .menu*     
*┃ ■ .alive*   
*┃ ■ .ping*     
*┃ ■ .system*   
*┃ ■ .settings* 
*┗━━━━━━━━━━━━━━━━━●◌*

*┏━━━━━━━━━━━━━━━━━●◌*
*┃    🎌 ANIME MENU*
*┗━━━━━━━━━━━━━━━━━●◌*
*┃ ■ .anime neko*    
*┃ ■ .anime waifu*    
*┃ ■ .anime hug*      
*┃ ■ .anime kiss*     
*┃ ■ .anime pat*      
*┗━━━━━━━━━━━━━━━━━●◌*

*┏━━━━━━━━━━━━━━━━━●◌*
*┃    ⚙️ OWNER MENU*
*┗━━━━━━━━━━━━━━━━━●◌*
*┃ ■ .set*        
*┃ ■ .group*      
*┃ ■ .autoreply*  
*┗━━━━━━━━━━━━━━━━━●◌*

*┏━━━━━━━━━━━━━━━━━●◌*
*┃    🔧 OTHER MENU*
*┗━━━━━━━━━━━━━━━━━●◌*
*┃ ■ .fonts*   
*┃ ■ .jid*     
*┃ ■ .freebot* 
*┗━━━━━━━━━━━━━━━━━●◌*

*📢 Channel:* ${CHANNEL_URL}
*👥 Group:* ${GROUP_URL}

> *- 𝙿𝙾𝚆𝙴𝚁𝙳 𝙱𝚈 𝚂𝙸𝙻𝙰 𝙼𝙳 𝙼𝙸𝙽𝙸 -*`;

    await socket.sendMessage(msg.key.remoteJid, {
      image: { url: botImg },
      caption: message,
      contextInfo: {
        mentionedJid: [msg.key.remoteJid],
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: '120363402325089913@newsletter',
          newsletterName: 'SILA MD',
          serverMessageId: 143,
        }
      }
    }, { quoted: msg });
  }
};
