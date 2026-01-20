// gemini-live.js
const { Modality } = require('@google/genai');
const { getGeminiLiveClient } = require('./gemini-client');
const { GEMINI_LIVE_MODEL, GEMINI_VOICE_NAME, buildSystemPrompt } = require('./config');
const LIVE_API_VERSION = process.env.GEMINI_LIVE_API_VERSION || 'v1alpha';

const DEBUG_GEMINI_LIVE = (() => {
  const raw = process.env.DEBUG_GEMINI ?? process.env.DEBUG_Echo ?? '';
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }
  return Boolean(raw);
})();

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * @typedef {Object} LiveConfig
 * @property {string[]} responseModalities - Modalities to expect from the model (AUDIO, TEXT)
 * @property {Object} [speechConfig] - Speech configuration
 * @property {Object} [speechConfig.voiceConfig] - Voice configuration
 * @property {Object} [speechConfig.voiceConfig.prebuiltVoiceConfig] - Prebuilt voice settings
 * @property {string} [speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName] - Name of the voice to use
 * @property {Object} systemInstruction - System prompt configuration
 */

/**
 * @typedef {Object} LiveCallbacks
 * @property {function(): void} [onopen] - WebSocket open callback
 * @property {function(Object): void} [onmessage] - Message received callback
 * @property {function(Error): void} [onerror] - Error callback
 * @property {function(CloseEvent): void} [onclose] - Close callback
 */

/**
 * @param {...any} args
 */
const debugLive = (...args) => {
  if (!DEBUG_GEMINI_LIVE) return;
  console.log('[Gemini Live DEBUG]', ...args);
};

function normalizeExtraContext(extraContext = '') {
  if (typeof extraContext !== 'string') return '';
  return extraContext.trim();
}

/**
 * @param {Object} params
 * @param {any} [params.config]
 * @param {string} [params.extraPromptContext]
 * @param {string} [params.voiceName]
 */
function buildLiveConfig({ config = {}, extraPromptContext = '', voiceName }) {
  const trimmedContext = normalizeExtraContext(extraPromptContext);
  const systemInstruction = {
    role: 'system',
    parts: [{ text: buildSystemPrompt(trimmedContext) }],
  };

  const requestedModalities = Array.isArray(config.responseModalities)
    ? config.responseModalities.filter(Boolean)
    : [];
  const responseModalities = [...new Set(requestedModalities)];
  if (responseModalities.length === 0) {
    responseModalities.push(Modality.AUDIO);
  }

  const liveConfig = {
    ...config,
    responseModalities,
    systemInstruction,
  };

  // Use preferred voice via passed voiceName or fall back to default
  const selectedVoice = voiceName || GEMINI_VOICE_NAME;
  if (!liveConfig.speechConfig && selectedVoice) {
    liveConfig.speechConfig = {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: selectedVoice,
        },
      },
    };
  }

  return liveConfig;
}

/**
 * @param {Function} fn
 * @param {string} label
 */
function safeCallback(fn, label) {
  if (typeof fn !== 'function') return undefined;
  return (/** @type {any[]} */ ...args) => {
    try {
      return fn(...args);
    } catch (error) {
      console.error(`[Gemini Live] ${label} callback failed:`, error);
      return undefined;
    }
  };
}


/**
 * Opens a Gemini Live session using the shared configuration layer.
 *
 * @param {Object} params
 * @param {string} params.extraPromptContext
 * @param {string} [params.voiceName] - Voice preset to use (optional)
 * @param {LiveCallbacks} params.callbacks
 * @param {import('@google/genai').LiveConnectConfig} [params.config]
 * @returns {Promise<any>} - Connected session
 */
async function connectLiveSession({ extraPromptContext = '', voiceName, callbacks, config = {} }) {
  const ai = getGeminiLiveClient();

  const liveConfig = buildLiveConfig({ config, extraPromptContext, voiceName });

  debugLive('Connecting live session', {
    model: GEMINI_LIVE_MODEL,
    apiVersion: LIVE_API_VERSION,
    responseModalities: liveConfig.responseModalities,
    hasSpeechConfig: Boolean(liveConfig.speechConfig),
    voiceName: liveConfig.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName || null,
    promptSnippet: normalizeExtraContext(extraPromptContext).slice(0, 120),
  });

  return ai.live.connect({
    model: GEMINI_LIVE_MODEL,
    config: liveConfig,
    callbacks: wrapCallbacksForDebug(callbacks),
  });
}

function wrapCallbacksForDebug(callbacks = {}) {
  // @ts-ignore
  const baseOnOpen = safeCallback(callbacks.onopen, 'onopen');
  // @ts-ignore
  const baseOnMessage = safeCallback(callbacks.onmessage, 'onmessage');
  // @ts-ignore
  const baseOnError = safeCallback(callbacks.onerror, 'onerror');
  // @ts-ignore
  const baseOnClose = safeCallback(callbacks.onclose, 'onclose');

  if (!DEBUG_GEMINI_LIVE) {
    return {
      onopen: baseOnOpen,
      onmessage: baseOnMessage,
      onerror: baseOnError,
      onclose: baseOnClose,
    };
  }

  return {
    onopen: () => {
      debugLive('WebSocket open');
      baseOnOpen?.();
    },
    onmessage: (/** @type {any} */ msg) => {
      debugLive('Received message', {
        type: msg?.serverContent ? 'serverContent' : 'unknown',
        hasSetup: Boolean(msg?.setupComplete),
        hasContent: Boolean(msg?.serverContent),
        hasToolCall: Boolean(msg?.toolCall),
        goAway: msg?.goAway || null,
      });
      baseOnMessage?.(msg);
    },
    onerror: (/** @type {any} */ error) => {
      debugLive('Error', error);
      baseOnError?.(error);
    },
    onclose: (/** @type {any} */ event) => {
      debugLive('Closed', {
        code: event?.code ?? null,
        reason: event?.reason ?? '',
        wasClean: event?.wasClean ?? null,
      });
      baseOnClose?.(event);
    },
  };
}

module.exports = {
  connectLiveSession,
};
