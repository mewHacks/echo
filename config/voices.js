// filepath: config/voices.js
// Gemini voice configuration and available voice presets

const GEMINI_VOICE_NAME = 'Iapetus';

const GEMINI_AVAILABLE_VOICES = [
  { value: 'Iapetus', description: 'Default balanced voice.' },
  { value: 'Zephyr', description: 'Bright, higher pitch.' },
  { value: 'Puck', description: 'Upbeat, middle pitch.' },
  { value: 'Charon', description: 'Informative, lower pitch.' },
  { value: 'Kore', description: 'Firm, middle pitch.' },
  { value: 'Fenrir', description: 'Excitable, lower-middle pitch.' },
  { value: 'Leda', description: 'Youthful, higher pitch.' },
  { value: 'Orus', description: 'Firm, lower-middle pitch.' },
  { value: 'Aoede', description: 'Breezy, middle pitch.' },
  { value: 'Callirrhoe', description: 'Easy-going, middle pitch.' },
  { value: 'Autonoe', description: 'Bright, middle pitch.' },
  { value: 'Enceladus', description: 'Breathy, lower pitch.' },
  { value: 'Umbriel', description: 'Easy-going, lower-middle pitch.' },
  { value: 'Algieba', description: 'Smooth, lower pitch.' },
  { value: 'Despina', description: 'Smooth, middle pitch.' },
  { value: 'Erinome', description: 'Clear, middle pitch.' },
  { value: 'Algenib', description: 'Gravelly, lower pitch.' },
  { value: 'Rasalgethi', description: 'Informative, middle pitch.' },
  { value: 'Laomedeia', description: 'Upbeat, higher pitch.' },
  { value: 'Achernar', description: 'Soft, higher pitch.' },
  { value: 'Alnilam', description: 'Firm, lower-middle pitch.' },
  { value: 'Schedar', description: 'Even, lower-middle pitch.' },
  { value: 'Gacrux', description: 'Mature, middle pitch.' },
  { value: 'Pulcherrima', description: 'Forward, middle pitch.' },
  { value: 'Achird', description: 'Friendly, lower-middle pitch.' },
  // { value: 'Vindemiatrix', description: 'Gentle, warm voice.' },
  // { value: 'Sadachbia', description: 'Lively, middle pitch.' },
  // { value: 'Sadaltager', description: 'Knowledgeable, middle pitch.' },
  // { value: 'Sulafat', description: 'Warm, rich voice.' },
];

module.exports = {
  GEMINI_VOICE_NAME,
  GEMINI_AVAILABLE_VOICES,
};
