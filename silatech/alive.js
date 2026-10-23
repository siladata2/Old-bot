module.exports = {
  name: 'alive',
  aliases: [],
  category: 'user',
  async execute(ctx) {
    const { socket, msg, number, botImg, socketCreationTime } = ctx;

    await socket.sendMessage(msg.key.remoteJid, { react: { text: "💚", key: msg.key }}, { quoted: msg });

    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const aliveMsg = `🤖 *SILA MD MINI IS ALIVE* 💚

╭━━━━━━━━━━━━━━━━●◌
│ *Status:* ✅ Online
│ *Uptime:* ${hours}h ${minutes}m ${seconds}s
│ *User:* ${number}
│ *Version:* 2.0.0
╰━━━━━━━━━━━━━━━━●◌

> _Bot is running smoothly_`;

    await socket.sendMessage(msg.key.remoteJid, {
      image: { url: botImg },
      caption: aliveMsg,
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
