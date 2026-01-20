// listeners/chat.js
const { runGeminiCore } = require('../core/gemini-orchestrator');
const { observe } = require('../core/observer'); // Passive observer entry point 

module.exports = {

  // Discord.js event name
  name: 'messageCreate',

  /**
   * @param {import('discord.js').Message} message
   */
  async execute(message) {
    // Passive observation that runs for every message, even if echo bot not mentioned
    try {
      await observe(message);
    } catch (err) {
      console.error('[Observer Hook Error]', err);
    }

    // Active chat filtering that ignores msg sent by bots
    if (message.author.bot) return;

    // Safety check in case client user might not be ready yet
    const clientUser = message.client.user;
    if (!clientUser) return;

    // If this is a DM (no guild), treat the whole message as a chat prompt
    if (!message.guild) {
      let promptText = (message.content || '').trim();

      // If user sends an empty message, default to "hi"
      if (!promptText) promptText = 'hi';

      // Collect file attachments (images, PDFs, etc.)
      const attachments = [...message.attachments.values()];

      // Fetch the replied-to message if this message is a reply
      const repliedMessage = await message.channel.messages.fetch(message.reference?.messageId).catch(() => null);

      // Run Gemini for the message
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
      return;
    }

    // Ignore @everyone and @here mentions
    if (message.mentions.everyone) return;

    // Only react when the bot is mentioned in guild channels
    if (!message.mentions.has(clientUser)) return;

    // Extract text after mention
    const botId = clientUser.id;
    const mentionRegex = new RegExp(`^<@!?${botId}>\\s*`, 'i');
    let promptText = message.content.replace(mentionRegex, '').trim();

    if (!promptText) {
      promptText = 'hi'; // default if user only typed @Echo
    }

    // Get all attachments
    const attachments = [...message.attachments.values()];

    // Get the replied-to message if it exists
    const repliedMessage = message.reference
      ? await message.channel.messages.fetch(message.reference.messageId).catch(() => null)
      : null;

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
  },
};
