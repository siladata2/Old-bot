module.exports = {
  name: 'ping',
  aliases: ['speed'],
  category: 'user',
  async execute(ctx) {
    const { socket, msg, reply, botImg } = ctx;
    await socket.sendMessage(msg.key.remoteJid, { react: { text: "🏓", key: msg.key }}, { quoted: msg });
    const start = Date.now();
    const pingMsg = await socket.sendMessage(msg.key.remoteJid, { text: '🏓 Pinging...' }, { quoted: msg });
    const ping = Date.now() - start;
    // Edit ile message ya kwanza
    await socket.sendMessage(msg.key.remoteJid, { text: `🏓 Pong! ${ping}ms`, edit: pingMsg.key });
    // Picha + caption ya matokeo
    await socket.sendMessage(msg.key.remoteJid, {
      image: { url: botImg },
      caption: `🏓 *PONG!*\n\n*Speed:* ${ping}ms\n*Status:* ✅ Online\n\n> SILA MD MINI`,
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
