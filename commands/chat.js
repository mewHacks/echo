const { SlashCommandBuilder } = require('discord.js');
const { runGeminiCore } = require('../core/gemini-orchestrator');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Chat with Echo (Gemini-powered), optionally with an image.')
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('Your message to Echo')
        .setRequired(true)
    )
    .addAttachmentOption(opt =>
      opt.setName('image')
        .setDescription('Optional image for Echo to look at')
        .setRequired(false)
    ),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   */
  async execute(interaction) {
    await interaction.deferReply();

    const promptText = interaction.options.getString('message', true);
    const imageAttachment = interaction.options.getAttachment('image') || null;
    const attachments = imageAttachment ? [imageAttachment] : [];

    await runGeminiCore({
      channel: interaction.channel,
      guild: interaction.guild,
      senderUser: interaction.user,
      promptText,
      attachments,
      repliedMessage: null,
      reply: async (content) => {
        return await interaction.editReply(content);
      },
    });
  },
};
