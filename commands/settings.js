// commands/settings.js
// Configure guild-level analysis and notification settings

const { SlashCommandBuilder, PermissionsBitField, MessageFlags } = require('discord.js');
const { getGuildSettings, updateGuildSettings } = require('../core/guild-settings');

const FEATURE_CHOICES = [
  { name: 'Passive logging', value: 'passiveLogging' },
  { name: 'Background analysis', value: 'backgroundAnalysis' },
  { name: 'Admin DM alerts', value: 'adminDm' },
  { name: 'Channel interventions', value: 'channelMessage' },
];

const formatStatus = (label, value) => `${value ? '✅' : '🚫'} ${label}: ${value ? 'On' : 'Off'}`;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure Echo analysis features for this server')
    .addSubcommand(sub =>
      sub
        .setName('view')
        .setDescription('View current settings')
    )
    .addSubcommand(sub =>
      sub
        .setName('set')
        .setDescription('Enable or disable a feature')
        .addStringOption(opt => {
          opt
            .setName('feature')
            .setDescription('Feature to configure')
            .setRequired(true);
          for (const choice of FEATURE_CHOICES) {
            opt.addChoices(choice);
          }
          return opt;
        })
        .addBooleanOption(opt =>
          opt
            .setName('value')
            .setDescription('Turn the feature on or off')
            .setRequired(true)
        )
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    if (!interaction.guild) {
      return interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
    }

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: 'Only administrators can change these settings.', flags: MessageFlags.Ephemeral });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'view') {
      const settings = await getGuildSettings(interaction.guild.id);
      const lines = [
        formatStatus('Passive logging', settings.passiveLogging),
        formatStatus('Background analysis', settings.backgroundAnalysis),
        formatStatus('Admin DM alerts', settings.adminDm),
        formatStatus('Channel interventions', settings.channelMessage),
      ];

      return interaction.reply({
        content: `**Current settings**\n${lines.join('\n')}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    if (subcommand === 'set') {
      const feature = interaction.options.getString('feature', true);
      const value = interaction.options.getBoolean('value', true);

      const updates = { [feature]: value };
      const updated = await updateGuildSettings(interaction.guild.id, updates);

      const label = FEATURE_CHOICES.find(c => c.value === feature)?.name || feature;

      return interaction.reply({
        content: `${label} is now ${value ? 'On' : 'Off'}.\n\nUpdated settings:\n${[
          formatStatus('Passive logging', updated.passiveLogging),
          formatStatus('Background analysis', updated.backgroundAnalysis),
          formatStatus('Admin DM alerts', updated.adminDm),
          formatStatus('Channel interventions', updated.channelMessage),
        ].join('\n')}`,
        flags: MessageFlags.Ephemeral,
      });
    }

    return interaction.reply({ content: 'Unsupported subcommand.', flags: MessageFlags.Ephemeral });
  },
};
