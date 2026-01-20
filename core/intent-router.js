// filepath: core/intent-router.js
// Intent detection to route requests to chat or action flow

const { getGeminiClient } = require('../gemini-client');
const { GEMINI_TEXT_MODEL } = require('../config/models');

/**
 * Detect if request is for chat or action (moderation/admin tool)
 * @param {string} promptText - User's prompt text
 * @returns {Promise<'chat'|'action'>}
 */
async function detectIntent(promptText) {
  try {
    const ai = getGeminiClient();
    const result = await ai.models.generateContent({
      model: GEMINI_TEXT_MODEL,
      contents: [{ role: 'user', parts: [{ text: promptText }] }],
      config: {
        systemInstruction: `You are an intent router for a Discord assistant. Return only the word "action" if the user wants a Discord moderation/administrative action or tool execution (kick, ban, delete messages, manage roles, update bot settings, etc). Return only "chat" for conversation, help, Q&A, small talk, or searches. Do not call tools. Do not add punctuation or extra words.`,
      },
    });
    
    const intentText = (result.text || '').trim().toLowerCase();
    return intentText === 'action' ? 'action' : 'chat';
  } catch (e) {
    console.error('Intent detection failed, defaulting to chat:', e);
    return 'chat';
  }
}

module.exports = {
  detectIntent,
};
