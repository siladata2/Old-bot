module.exports = {
  name: 'ping',
  aliases: ['speed'],
  category: 'user',
  async execute(ctx) {
    const { socket, msg } = ctx;
    await socket.sendMessage(msg.key.remoteJid, { react: { text: "🏓", key: msg.key }}, { quoted: msg });
    const start = Date.now();
    const pingMsg = await socket.sendMessage(msg.key.remoteJid, { text: '🏓 Pinging...' }, { quoted: msg });
    const ping = Date.now() - start;
    await socket.sendMessage(msg.key.remoteJid, { text: `🏓 Pong! ${ping}ms`, edit: pingMsg.key });
  }
};
