// DEPRECATED: Backward compatibility file
// New code should import from config/ modules directly
// 
// This file re-exports from the new modular config structure for backward compatibility

const {
  BASE_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  TEXT_MODE_CONTEXT,
  buildSystemPrompt,
  GEMINI_TEXT_MODEL,
  GEMINI_TOOL_MODEL,
  GEMINI_LIVE_MODEL,
  GEMINI_TRANSCRIBE_MODEL,
  GEMINI_VOICE_NAME,
  GEMINI_AVAILABLE_VOICES,
} = require('../config');

module.exports = {
  SYSTEM_PROMPT,
  BASE_SYSTEM_PROMPT,
  TEXT_MODE_CONTEXT,
  buildSystemPrompt,
  GEMINI_TEXT_MODEL,
  GEMINI_TOOL_MODEL,
  GEMINI_LIVE_MODEL,
  GEMINI_TRANSCRIBE_MODEL,
  GEMINI_VOICE_NAME,
  GEMINI_AVAILABLE_VOICES,
};
