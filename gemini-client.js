// gemini-client.js
const { GoogleGenAI } = require('@google/genai');

const clientCache = new Map();

/**
 * Normalize options by removing null/undefined values
 * @param {Record<string, any>} options
 * @returns {Record<string, any>}
 */
function normalizeOptions(options = {}) {
  /** @type {Record<string, any>} */
  const normalized = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    normalized[key] = value;
  }
  return normalized;
}

function cacheKeyFromOptions(options = {}) {
  const normalized = normalizeOptions(options);
  const entries = Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

function getGeminiClient(options = {}) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in the environment.');
  }

  const sanitizedOptions = normalizeOptions({ ...options });
  const key = cacheKeyFromOptions(sanitizedOptions);

  if (!clientCache.has(key)) {
    clientCache.set(key, new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      ...sanitizedOptions,
    }));
  }

  return clientCache.get(key);
}

function getGeminiLiveClient() {
  const apiVersion = process.env.GEMINI_LIVE_API_VERSION || 'v1alpha';
  return getGeminiClient({ apiVersion });
}

module.exports = {
  getGeminiClient,
  getGeminiLiveClient,
};
