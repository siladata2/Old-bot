// commands-loader.js
const fs = require('fs-extra');
const path = require('path');

const COMMANDS_DIR = path.join(__dirname, 'silatech');

// Registry ya commands
const commands = new Map();

/**
 * Load all command files from silatech/ folder
 * Each file should export: { name, aliases, category, ownerOnly, groupOnly, execute }
 */
async function loadCommands() {
  commands.clear();

  if (!fs.existsSync(COMMANDS_DIR)) {
    fs.ensureDirSync(COMMANDS_DIR);
    console.log('📁 Created silatech/ folder');
    return commands;
  }

  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.js'));

  for (const file of files) {
    const filePath = path.join(COMMANDS_DIR, file);
    try {
      // Clear require cache ili command mpya ibadilike bila restart
      delete require.cache[require.resolve(filePath)];
      const mod = require(filePath);

      if (!mod || !mod.name || typeof mod.execute !== 'function') {
        console.warn(`⚠️  Skipped ${file}: missing "name" or "execute"`);
        continue;
      }

      // Register name kuu
      commands.set(mod.name.toLowerCase(), mod);

      // Register aliases
      if (Array.isArray(mod.aliases)) {
        for (const alias of mod.aliases) {
          commands.set(alias.toLowerCase(), mod);
        }
      }

      console.log(`✅ Loaded command: ${mod.name} (${file})`);
    } catch (err) {
      console.error(`❌ Failed to load ${file}:`, err.message);
    }
  }

  console.log(`📦 Total commands loaded: ${commands.size}`);
  return commands;
}

/**
 * Pata command kwa jina
 */
function getCommand(name) {
  if (!name) return null;
  return commands.get(name.toLowerCase()) || null;
}

/**
 * Pata commands zote (kwa menu)
 */
function getAllCommands() {
  const unique = new Map();
  for (const [key, cmd] of commands.entries()) {
    if (!unique.has(cmd.name)) unique.set(cmd.name, cmd);
  }
  return Array.from(unique.values());
}

module.exports = { loadCommands, getCommand, getAllCommands, commands };
