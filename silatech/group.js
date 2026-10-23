module.exports = {
  name: 'group',
  aliases: ['gc'],
  category: 'owner',
  ownerOnly: true,
  groupOnly: true,
  async execute(ctx) {
    const { socket, msg, args, reply } = ctx;
    try {
      await socket.sendMessage(msg.key.remoteJid, { react: { text: "👥", key: msg.key }}, { quoted: msg });
      const subcmd = args[0]?.toLowerCase();

      switch (subcmd) {
        case 'info': {
          const metadata = await socket.groupMetadata(msg.key.remoteJid);
          const infoMsg = `👥 *GROUP INFO*\n\n` +
            `*Name:* ${metadata.subject}\n` +
            `*ID:* ${metadata.id}\n` +
            `*Participants:* ${metadata.participants.length}\n` +
            `*Creation:* ${new Date(metadata.creation * 1000).toLocaleDateString()}\n` +
            `*Owner:* ${metadata.owner ? metadata.owner.split('@')[0] : 'Unknown'}\n` +
            `*Description:* ${metadata.desc || 'No description'}`;
          await reply(infoMsg);
          break;
        }
        case 'promote': {
          const userToPromote = msg.message?.extendedTextMessage?.contextInfo?.participant || args[1] + '@s.whatsapp.net';
          await socket.groupParticipantsUpdate(msg.key.remoteJid, [userToPromote], 'promote');
          await reply(`✅ Promoted user: ${userToPromote.split('@')[0]}`);
          break;
        }
        case 'demote': {
          const userToDemote = msg.message?.extendedTextMessage?.contextInfo?.participant || args[1] + '@s.whatsapp.net';
          await socket.groupParticipantsUpdate(msg.key.remoteJid, [userToDemote], 'demote');
          await reply(`✅ Demoted user: ${userToDemote.split('@')[0]}`);
          break;
        }
        case 'kick': {
          const userToKick = msg.message?.extendedTextMessage?.contextInfo?.participant || args[1] + '@s.whatsapp.net';
          await socket.groupParticipantsUpdate(msg.key.remoteJid, [userToKick], 'remove');
          await reply(`✅ Kicked user: ${userToKick.split('@')[0]}`);
          break;
        }
        default:
          await reply("🚫 Available group commands:\n• .group info\n• .group promote [@user]\n• .group demote [@user]\n• .group kick [@user]");
      }
    } catch (e) {
      await reply("🚫 Error executing group command.");
    }
  }
};
