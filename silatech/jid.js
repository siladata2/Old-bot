module.exports = {
  name: 'jid',
  aliases: [],
  category: 'other',
  async execute(ctx) {
    const { socket, msg, reply } = ctx;
    try {
      await socket.sendMessage(msg.key.remoteJid, { react: { text: "🆔", key: msg.key }}, { quoted: msg });
      await reply(`🆔 *CHAT JID*\n\n\`${msg.key.remoteJid}\``);
    } catch (e) {
      await reply("🚫 Error getting JID.");
    }
  }
};
