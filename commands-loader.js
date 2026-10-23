// commands-loader.js
const fs = require('fs-extra');
const path = require('path');

const COMMANDS_DIR = path.join(__dirname, 'silatech');
const commands = new Map();

function logInfo(...args) { console.log(`[LOADER] ℹ️`, ...args); }
function logOk(...args) { console.log(`[LOADER] ✅`, ...args); }
function logWarn(...args) { console.warn(`[LOADER] ⚠️`, ...args); }
function logErr(...args) { console.error(`[LOADER] ❌`, ...args); }

async function loadCommands() {
  logInfo('loadCommands() starting...');
  logInfo(`Commands directory: ${COMMANDS_DIR}`);

  commands.clear();
  logInfo('Registry cleared');

  if (!fs.existsSync(COMMANDS_DIR)) {
    logWarn('silatech/ folder does not exist — creating it');
    fs.ensureDirSync(COMMANDS_DIR);
    return commands;
  }

  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.js'));
  logInfo(`Found ${files.length} command files`);

  for (const file of files) {
    const filePath = path.join(COMMANDS_DIR, file);
    try {
      delete require.cache[require.resolve(filePath)];
      const mod = require(filePath);

      logInfo(`Loaded ${file}`, {
        hasModule: !!mod,
        hasName: !!mod?.name,
        nameValue: mod?.name,
        hasExecute: typeof mod?.execute,
        aliases: mod?.aliases,
        category: mod?.category
      });

      if (!mod || !mod.name || typeof mod.execute !== 'function') {
        logWarn(`Skipped ${file}: missing "name" or "execute"`, {
          hasName: !!mod?.name,
          executeType: typeof mod?.execute
        });
        continue;
      }

      const mainKey = mod.name.toLowerCase();
      commands.set(mainKey, mod);
      logOk(`Registered command: ${mainKey}`);

      if (Array.isArray(mod.aliases)) {
        for (const alias of mod.aliases) {
          const aliasKey = alias.toLowerCase();
          commands.set(aliasKey, mod);
          logOk(`Registered alias: ${aliasKey} → ${mainKey}`);
        }
      }
    } catch (err) {
      logErr(`Failed to load ${file}:`, err.message);
      logErr(err.stack);
    }
  }

  logOk(`Total registered keys: ${commands.size}`);
  logInfo(`Registry keys: ${Array.from(commands.keys()).join(', ')}`);

  return commands;
}

function getCommand(name) {
  if (!name) return null;
  const key = name.toLowerCase();
  const cmd = commands.get(key);
  if (!cmd) {
    logWarn(`getCommand('${name}') NOT FOUND`);
    return null;
  }
  return cmd;
}

function getAllCommands() {
  const unique = new Map();
  for (const [key, cmd] of commands.entries()) {
    if (!unique.has(cmd.name)) unique.set(cmd.name, cmd);
  }
  const list = Array.from(unique.values());
  logInfo(`getAllCommands() => ${list.length} unique commands`);
  return list;
}

module.exports = { loadCommands, getCommand, getAllCommands, commands };