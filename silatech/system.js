module.exports = {
  name: 'system',
  aliases: ['sys'],
  category: 'user',
  async execute(ctx) {
    const { socket, msg, os, reply } = ctx;
    await socket.sendMessage(msg.key.remoteJid, { react: { text: "💻", key: msg.key }}, { quoted: msg });

    const totalMem = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
    const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
    const usedMem = (totalMem - freeMem).toFixed(2);
    const uptime = Math.floor(process.uptime());
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    const systemMsg = `💻 *SYSTEM INFORMATION*

╭━━━━━━━━━━━━━━━━●◌
│ *OS:* ${os.type()} ${os.release()}
│ *Arch:* ${os.arch()}
│ *Platform:* ${os.platform()}
│ *CPU:* ${os.cpus()[0].model}
│ *Cores:* ${os.cpus().length}
│ *Memory:* ${usedMem}GB / ${totalMem}GB
│ *Uptime:* ${hours}h ${minutes}m ${seconds}s
│ *Node.js:* ${process.version}
╰━━━━━━━━━━━━━━━━●◌`;

    await reply(systemMsg);
  }
};
