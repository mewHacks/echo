// commands/ping.js
const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Ping a user a limited number of times.')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to ping')
        .setRequired(true)
    )
    .addIntegerOption(option =>
      option.setName('count')
        .setDescription('How many times to ping (max 5)')
        .addChoices(
          { name: '1 time', value: 1 },
          { name: '2 times', value: 2 },
          { name: '3 times', value: 3 },
          { name: '4 times', value: 4 },
          { name: '5 times', value: 5 },
        )
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    const targetUser = interaction.options.getUser('user', true);
    let count = interaction.options.getInteger('count') ?? 1;

    // Permission check: only allow users with Manage Server (ManageGuild) to run
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the "Manage Server" permission to run this command.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Safety clamp
    if (count < 1) count = 1;
    if (count > 5) count = 5;

    await interaction.reply({
      content: `Okay, I will ping ${targetUser} ${count} time(s).`,
    });

    const channel = interaction.channel;
    if (!channel) return;

    const delayMs = 2000; // 2 seconds, not spammy

    for (let i = 0; i < count; i++) {
      await sleep(delayMs);
      await channel.send(`${targetUser}`);
    }
  },
};
