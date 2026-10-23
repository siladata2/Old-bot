module.exports = {
  name: 'settings',
  aliases: ['config'],
  category: 'user',
  async execute(ctx) {
    const { socket, msg, number, reply, storageAPI } = ctx;
    try {
      await socket.sendMessage(msg.key.remoteJid, { react: { text: "⚙️", key: msg.key }}, { quoted: msg });
      const settings = await storageAPI.getSettings(number);
      const settingsMsg = `⚙️ *BOT SETTINGS*\n\n` +
        `*Work Type:* ${settings.worktype || 'public'}\n` +
        `*Auto Read:* ${settings.autoread ? '✅' : '❌'}\n` +
        `*Online Presence:* ${settings.online ? '✅' : '❌'}\n` +
        `*Auto Status View:* ${settings.autoswview ? '✅' : '❌'}\n` +
        `*Auto Status Like:* ${settings.autoswlike ? '✅' : '❌'}\n\n` +
        `*Use commands to change settings:*\n` +
        `.set worktype [public/private/group/inbox]\n` +
        `.set autoread [on/off]\n` +
        `.set online [on/off]`;

      await reply(settingsMsg);
    } catch (e) {
      await reply("🚫 Error fetching settings.");
    }
  }
};
