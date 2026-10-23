module.exports = {
  name: 'autoreply',
  aliases: ['ar'],
  category: 'owner',
  ownerOnly: true,
  async execute(ctx) {
    const { socket, msg, args, reply } = ctx;
    try {
      await socket.sendMessage(msg.key.remoteJid, { react: { text: "🤖", key: msg.key }}, { quoted: msg });
      const [subcmd, ...replyArgs] = args;

      switch (subcmd) {
        case 'add':
          if (replyArgs.length < 2) return await reply("🚫 Usage: .autoreply add [trigger] [response]");
          const trigger = replyArgs[0].toLowerCase();
          const response = replyArgs.slice(1).join(' ');
          await reply(`✅ Auto-reply added:\nTrigger: ${trigger}\nResponse: ${response}`);
          break;
        case 'list':
          await reply("🔧 Auto-reply list feature coming soon...");
          break;
        case 'remove':
          await reply("🔧 Auto-reply remove feature coming soon...");
          break;
        default:
          await reply("🚫 Available auto-reply commands:\n• .autoreply add [trigger] [response]\n• .autoreply list\n• .autoreply remove [trigger]");
      }
    } catch (e) {
      await reply("🚫 Error managing auto-replies.");
    }
  }
};
