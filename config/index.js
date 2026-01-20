// filepath: config/index.js
// Backward compatibility re-exports for existing imports

const { BASE_SYSTEM_PROMPT, TEXT_MODE_CONTEXT, buildSystemPrompt } = require('./prompts');
const { GEMINI_TEXT_MODEL, GEMINI_TOOL_MODEL, GEMINI_LIVE_MODEL, GEMINI_ANALYZER_MODEL } = require('./models');
const { GEMINI_VOICE_NAME, GEMINI_AVAILABLE_VOICES } = require('./voices');

// Kept for backward compatibility, but prefer importing from specific modules
const SYSTEM_PROMPT = BASE_SYSTEM_PROMPT;

module.exports = {
  // From prompts
  BASE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  TEXT_MODE_CONTEXT,
  buildSystemPrompt,

  // From models
  GEMINI_TEXT_MODEL,
  GEMINI_TOOL_MODEL,
  GEMINI_LIVE_MODEL,
  GEMINI_ANALYZER_MODEL,

  // From voices
  GEMINI_VOICE_NAME,
  GEMINI_AVAILABLE_VOICES,
};
