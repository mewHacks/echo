// index.js (excerpt)
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Events, Partials, ActivityType } = require('discord.js');
const express = require('express');
const { buildApiRouter } = require('./api');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent, // needed to read normal messages
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers, // Required to fetch members/moderators
  ],
  partials: [Partials.Channel],
});

// Register client singleton for global access (used by intervention-planner, etc.)
const { setDiscordClient } = require('./discord-client');
setDiscordClient(client);

const app = express();
const API_PORT = Number(process.env.API_PORT) || 3000;

app.use(express.json());
app.use('/api', buildApiRouter({ client }));

app.listen(API_PORT, () => {
  console.log(`[API] Listening on port ${API_PORT}`);
});

client.commands = new Collection();

// --- load commands (you probably already have this) ---
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  const command = require(filePath);
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  }
}

// --- load listeners/events ---
const listenersPath = path.join(__dirname, 'listeners');
if (fs.existsSync(listenersPath)) {
  const listenerFiles = fs.readdirSync(listenersPath).filter(file => file.endsWith('.js'));

  for (const file of listenerFiles) {
    const filePath = path.join(listenersPath, file);
    const event = require(filePath);
    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args));
    } else {
      client.on(event.name, (...args) => event.execute(...args));
    }
  }
}

// existing interaction handler etc...
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply('❌ There was an error while executing this command.');
    } else {
      await interaction.reply({ content: '❌ There was an error while executing this command.', flags: 64 });
    }
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  c.user.setPresence({
    activities: [

      {
        name: 'Mention me to start chatting!',
        type: ActivityType.Custom,
      },
    ],
    status: 'online',
  });

  // Start scheduler
  const { startScheduler } = require('./core/scheduler');
  startScheduler();
});

// --- Message Event Tracking ---
// Track edits and deletions for comprehensive context analysis
const { observeEdit, observeDelete } = require('./core/observer');

// Message edited - track content changes (e.g., backpedaling after conflict)
client.on(Events.MessageUpdate, async (oldMessage, newMessage) => {
  try {
    await observeEdit(oldMessage, newMessage);
  } catch (err) {
    console.error('[Observer] Error in messageUpdate handler:', err);
  }
});

// Message deleted - track deletions (e.g., regret after heated message)
client.on(Events.MessageDelete, async (message) => {
  try {
    await observeDelete(message);
  } catch (err) {
    console.error('[Observer] Error in messageDelete handler:', err);
  }
});

client.login(process.env.DISCORD_TOKEN);
