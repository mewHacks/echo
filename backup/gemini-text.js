// filepath: gemini-text.js
// DEPRECATED: This file is now a compatibility adapter
// New code should import directly from core/ and utils/ modules

// Re-export the main orchestration function from refactored core
const { runGeminiCore } = require('../core/gemini-orchestrator');

// ---------- Public helpers: slash command & mention ----------

async function runGeminiForInteraction(interaction) {
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
}

async function runGeminiForMessage(message, promptText, attachments = [], repliedMessage = null) {
  await runGeminiCore({
    channel: message.channel,
    guild: message.guild,
    senderUser: message.author,
    promptText,
    attachments,
    repliedMessage,
    reply: async (content) => {
      return await message.reply(content);
    },
  });
}

module.exports = {
  runGeminiForInteraction,
  runGeminiForMessage,
};
