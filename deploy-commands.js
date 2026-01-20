// deploy-commands.js
const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');
require('dotenv').config();

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);

  if ('data' in command && 'toJSON' in command.data) {
    commands.push(command.data.toJSON());
    console.log(`Registered command definition: ${command.data.name}`);
  } else {
    console.warn(`[WARNING] The command at ${filePath} is missing "data" or "data.toJSON()".`);
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const clientId = process.env.CLIENT_ID;

    if (!clientId) {
      throw new Error('Missing CLIENT_ID in environment variables.');
    }

    console.log(`Started refreshing ${commands.length} global application (/) commands.`);
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands },
    );
    console.log('Successfully reloaded global application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();
