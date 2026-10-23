module.exports = {
  name: 'set',
  aliases: [],
  category: 'owner',
  ownerOnly: true,
  async execute(ctx) {
    const { socket, msg, args, reply, number, storageAPI } = ctx;
    try {
      await socket.sendMessage(msg.key.remoteJid, { react: { text: "🔧", key: msg.key }}, { quoted: msg });
      const [setting, value] = args;
      if (!setting || !value) {
        return await reply("🚫 Usage: .set [setting] [value]\n\nAvailable settings: worktype, autoread, online, autoswview, autoswlike");
      }

      const settings = await storageAPI.getSettings(number);
      let updated = false;

      switch (setting) {
        case 'worktype':
          if (['public', 'private', 'group', 'inbox'].includes(value)) {
            settings.worktype = value;
            updated = true;
          }
          break;
        case 'autoread':
          settings.autoread = value === 'on';
          updated = true;
          break;
        case 'online':
          settings.online = value === 'on';
          updated = true;
          break;
        case 'autoswview':
          settings.autoswview = value === 'on';
          updated = true;
          break;
        case 'autoswlike':
          settings.autoswlike = value === 'on';
          updated = true;
          break;
      }

      if (updated) {
        await storageAPI.saveSettings(number, settings);
        await reply(`✅ Setting updated:\n*${setting}* → *${value}*`);
      } else {
        await reply("🚫 Invalid setting or value.");
      }
    } catch (e) {
      await reply("🚫 Error updating settings.");
    }
  }
};
