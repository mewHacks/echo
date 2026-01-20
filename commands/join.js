// commands/join.js
// Slash command to join voice channel and start Gemini Live voice session

/* IMPORTS */
const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { startVoiceSession, getVoiceSession } = require('../voiceSessionManager');
const { GEMINI_AVAILABLE_VOICES } = require('../config');

// Build voice choices from config array
const VOICE_CHOICES = (GEMINI_AVAILABLE_VOICES || []).map(({ value, description }) => ({
  name: description ? `${value} (${description})` : value,
  value,
}));

/* COMMAND DEFINITION */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('join')
    .setDescription('Bring Echo into your current voice chat (voice beta · expect instability).')
    .addStringOption((option) => {
      option
        .setName('voice')
        .setDescription('Optional: choose a beta voice preset')
        .setRequired(false);

      // Add all available voice choices from config
      for (const choice of VOICE_CHOICES) {
        option.addChoices(choice);
      }
      return option;
    }),

  // Execute function called when user runs /join
  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {

    // Ensure command is run in a guild (not DMs)
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used inside a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    // Defer reply to prevent Discord timeout (voice connection takes >3 seconds)
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Fetch guild member object
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const voiceChannel = member.voice?.channel;

    // Check if user is in a voice channel
    if (!voiceChannel || (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice)) {
      await interaction.editReply('you have to be in a voice chat');
      return;
    }

    // Get bot's guild member object
    const me = interaction.guild.members.me;
    if (!me) {
      await interaction.editReply('I could not verify my permissions in this server.');
      return;
    }

    // Check bot permissions in voice channel
    const permissions = voiceChannel.permissionsFor(me);
    if (!permissions?.has(PermissionFlagsBits.Connect) || !permissions.has(PermissionFlagsBits.Speak)) {
      await interaction.editReply('I need the Connect and Speak permissions in that voice channel.');
      return;
    }

    // Check if bot is already in this channel
    if (getVoiceSession(voiceChannel.id)) {
      await interaction.editReply('I\'m already active in that voice channel.');
      return;
    }

    // Get voice preset from user input
    const selectedVoice = interaction.options.getString('voice');

    try {
      // Start voice session (joins voice, connects to Gemini, starts listening)
      await startVoiceSession({
        voiceChannel,
        initiatedBy: interaction.user,
        voiceName: selectedVoice || undefined,
      });

      // Success message
      const voiceLabel = selectedVoice ? `Voice preset: ${selectedVoice}. ` : '';
      await interaction.editReply(`Listening in **${voiceChannel.name}** now. ${voiceLabel}(Voice beta—may behave unpredictably.)`);

    } catch (error) {
      // Error handling for voice session startup failures
      console.error('[commands/join] Failed to start voice session:', error);
      await interaction.editReply('I could not start the voice session. Please try again in a moment.');
    }
  },
};
