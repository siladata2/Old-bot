module.exports = {
  name: 'freebot',
  aliases: [],
  category: 'other',
  async execute(ctx) {
    const { socket, msg, reply } = ctx;
    try {
      await socket.sendMessage(msg.key.remoteJid, { react: { text: "🤖", key: msg.key }}, { quoted: msg });
      const freebotMsg = `🤖 *CONNECT FREE BOT*\n\n` +
        `To connect SILA MD MINI to your WhatsApp:\n\n` +
        `1. Visit our website https://min-bot-ewan.onrender.com or\n` +
        `2. Use the pairing system\n` +
        `3. Get your personal bot instance\n\n` +
        `*Features:*\n` +
        `✅ YouTube Downloader\n` +
        `✅ TikTok Downloader\n` +
        `✅ Facebook Downloader\n` +
        `✅ Anime Images\n` +
        `✅ Group Management\n` +
        `✅ Auto-reply System\n\n` +
        `_Contact admin for more info_`;

      await reply(freebotMsg);
    } catch (e) {
      await reply("🚫 Error displaying freebot info.");
    }
  }
};
