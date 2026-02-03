// voiceSessionManager.js
// Coordinates two systems (Discord users voice + Gemini Live) in real time

/*
   Architecture:
   - VoiceSessionManager: Main voice orchestrator 
   - UserAudioReceiver: Handles input (Discord → Gemini)
   - AudioStreamManager: Handles playback (Gemini → Discord)

   Flow:
   1. User runs /join
   2. Bot joins voice channel
   3. Connects to Gemini Live WebSocket
   4. UserAudioReceiver captures user speech
   5. Forward to Gemini
   6. Gemini responds with audio
   7. AudioStreamManager plays response
   8. Repeat until hangup or timeout
*/

/* IMPORTS */
const { // Discord voice primitives, does not handle audio internals (Opus, FFmpeg, PCM math)
  joinVoiceChannel, createAudioPlayer, NoSubscriberBehavior, VoiceConnectionStatus, AudioPlayerStatus, entersState,
} = require('@discordjs/voice');
const { ChannelType } = require('discord.js');
const { connectLiveSession } = require('./gemini-live'); // Abstracts Gemini Live WebSocket creation
const { GEMINI_VOICE_NAME } = require('./config');
const { UserAudioReceiver } = require('./voice/UserAudioReceiver'); // Input (Discord → Gemini)
const { AudioStreamManager } = require('./voice/AudioStreamManager'); // Output (Gemini → Discord)

/* CONSTANTS */
const VOICE_READY_TIMEOUT = 15_000; // Safety timeout for Discord voice connection so /join cannot hang forever
const sessions = new Map(); // Active voice sessions, one session per voice channel
const PCM_MIME_TYPE = 'audio/pcm;rate=48000'; // PCM audio format for sending to Gemini (48kHz)
const STAGE_SPEAK_PROMPT = 'Discord still suppresses Echo in this stage channel. Please use "Invite to Speak" or grant the bot Stage Moderator permissions so its audio can be heard.'; // Warning message for stage channels where bot can't speak
const IDLE_TIMEOUT_MS = 60_000; // Idle timeout to disconnect after 60 seconds of silence
const HANGUP_KEYWORD = '<<<TERMINATE_SESSION>>>'; // Unique hangup detection keyword for text summaries
const PERIODIC_ANALYSIS_INTERVAL_MS = 30_000; // Run background conflict analysis every 30 seconds (Faster sensitive check)

const CALL_END_INSTRUCTION = `
CRITICAL HANGUP PROTOCOL:
If the user indicates they are done ("goodbye", "bye", "see you", "disconnect", "stop", "sayonara", "adios", "ciao", etc.), you MUST follow this EXACT sequence:
1. Say a brief, friendly goodbye (max 5 words).
2. IMMEDIATELY output the termination token: "${HANGUP_KEYWORD}".

RULES:
- DO NOT ask follow-up questions ("Anything else?").
- DO NOT describe your plan ("I will now disconnect..."). Just output the token.
- The token is the ONLY way the call actually ends. If you forget it, the call stays open.

CORRECT: "See you later! ${HANGUP_KEYWORD}"
WRONG: "Okay, I'll leave now." (Stays open forever)
`.trim();

// Debug logging flag from multiple environment variables
const DEBUG_GEMINI_VOICE = (() => {
  const raw = process.env.DEBUG_GEMINI ?? process.env.DEBUG_Echo ?? '';
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }
  return Boolean(raw);
})();

// Cheap debug logger (only logs if DEBUG_GEMINI_VOICE is enabled)
const debugVoice = (...args) => {
  if (!DEBUG_GEMINI_VOICE) return;
  console.log('[VoiceSession DEBUG]', ...args);
};

/* VoiceSession CLASS */

/*
   Orchestrates a live voice conversation between Discord users and Gemini

   Responsibilities:
   - Connect to Discord voice channel
   - Connect to Gemini Live WebSocket
   - Coordinate audio input (UserAudioReceiver) and output (AudioStreamManager)
   - Manage session lifecycle (timeouts, hangup detection, cleanup)

   Delegates:
   - Audio playback → AudioStreamManager
   - User audio capture → UserAudioReceiver

   Example:
   const session = new VoiceSession({ voiceChannel, initiatedBy });
   await session.start();
   // ... conversation happens ...
   await session.destroy('User hung up');

*/

class VoiceSession {
  /**
   * @param {Object} config
   * @param {import('discord.js').VoiceChannel} config.voiceChannel - Discord voice channel to join
   * @param {import('discord.js').User} config.initiatedBy - User who started the session
   * @param {string} [config.voiceName] - Gemini voice preset (optional)
   */

  // Constructor
  constructor({ voiceChannel, initiatedBy, voiceName }) {

    // Discord connection 
    this.voiceChannel = voiceChannel; /** @type {import('discord.js').VoiceChannel} */
    this.initiatedBy = initiatedBy; /** @type {import('discord.js').User} - User who ran command '/join' */
    this.connection = null; /** @type {import('@discordjs/voice').VoiceConnection|null} */
    this.audioPlayer = null; /** @type {import('@discordjs/voice').AudioPlayer|null} */

    // Gemini connection
    this.liveSession = null; /** @type {Object|null} - Gemini Live WebSocket session */
    this.voiceName = voiceName || GEMINI_VOICE_NAME; /** @type {string} - Gemini voice preset (e.g., 'Puck', 'Charon') */
    this.setupComplete = false; /** @type {boolean} - Has Gemini sent setupComplete? */
    this.initialInstructionsSent = false; /** @type {boolean} - Have we sent initial instructions to Gemini? */

    // Audio managers
    this.audioStreamManager = null; /** @type {AudioStreamManager|null} - Manages playback (Gemini → Discord) */
    this.userAudioReceiver = null; /** @type {UserAudioReceiver|null} - Manages input (Discord → Gemini) */

    // Session state
    this.destroyed = false; /** @type {boolean} - Has this session been destroyed? */
    this.botUserId = voiceChannel.client?.user?.id ?? null; /** @type {string|null} - Bot's Discord user ID (to ignore own audio) */
    this.conversationHistory = []; /** @type {string[]} - Recent conversation summaries for context preservation on reconnect (max 3) */
    this.sessionSummaryBuffer = ''; /** @type {string} - Accumulated session summary (max 1000 chars) to prevent "last sentence" memory */
    this.lastSummaryTimestamp = null; /** @type {number|null} - Timestamp of last summary for time-based context filtering */

    // Reconnection state
    this.isReconnecting = false; /** @type {boolean} - Are we currently reconnecting? */
    this.reconnectAttempts = 0; /** @type {number} - Current reconnection attempt count */
    this.maxReconnectAttempts = 3; /** @type {number} - Max reconnection attempts before giving up */
    this.reconnectTimeoutHandle = null; /** @type {NodeJS.Timeout|null} - Reconnection backoff timer */

    // Timeouts and cleanup
    this.idleTimer = null; /** @type {NodeJS.Timeout|null} - Idle timeout (disconnect after 60 seconds silence) */
    this.sessionEndRequested = false; /** @type {boolean} - Has user requested to hang up? */
    this.pendingDestroyReason = null; /** @type {string|null} - Pending destroy reason */
    this.destroyAfterPlaybackHandle = null; /** @type {NodeJS.Timeout|null} - Delay destroy until audio finishes */
    this.goodbyeTimeoutHandle = null; /** @type {NodeJS.Timeout|null} - Timeout for waiting for goodbye response */
  }

  /* SESSION LIFECYCLE */

  // Starts the voice session
  async start() {
    await this.joinChannel(); // Join Discord voice channel
    await this.connectGemini(); // Connect to Gemini Live
    this.setupAudioManagers(); // Setup audio managers
    debugVoice(`Voice session ready in ${this.voiceChannel.name}`);
  }

  // Joins the Discord voice channel and sets up audio player
  async joinChannel() {

    // Join voice channel
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.voiceChannel.guild.id,
      adapterCreator: this.voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false, // Need to hear users
      selfMute: false, // Need to speak back
    });

    // Hard-kills session if Discord drops connection
    this.connection.on('stateChange', (oldState, newState) => {
      if (this.destroyed) return;
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        void this.destroy('Voice connection closed.');
      }
    });

    // Wait for connection to be ready to ensure voice readiness before proceeding
    await entersState(this.connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT);

    // Create audio player and stops playback cleanly if nobody is listening
    this.audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Stop,
      },
    });

    // Handle audio player state changes
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      if (this.destroyed) return;
      debugVoice('Audio player state change', oldState.status, '→', newState.status);
    });

    // Handle audio player errors
    this.audioPlayer.on('error', (error) => {
      console.error('[VoiceSession] Audio player error:', error);
    });

    // Connect Discord audio player to voice connection
    this.connection.subscribe(this.audioPlayer);

    // Ensure bot can speak in stage channels
    await this.ensureSpeakingPermissions();
  }

  // Ensures bot has speaking permissions in stage channels
  async ensureSpeakingPermissions() {

    // Bots are often suppressed by default in stage channels
    if (this.voiceChannel.type !== ChannelType.GuildStageVoice) {
      return;
    }

    // Try to unsuppress bot if suppressed
    try {
      // Fetch guild and bot member's object
      const guild = this.voiceChannel.guild;
      const me = await guild.members.fetchMe();

      // If bot is not suppressed, do nothing
      if (!me.voice.suppressed) {
        return;
      }

      // Try to unsuppress the bot by requesting Discord to do so
      debugVoice('Bot is suppressed in stage channel, attempting to unsuppress');
      await me.voice.setSuppressed(false);

      // If bot is still suppressed, show warning
      if (me.voice.suppressed) {
        console.warn('[VoiceSession]', STAGE_SPEAK_PROMPT);
      }

    } catch (error) { // If failed to unsuppress, show warning
      console.warn('[VoiceSession] Failed to unsuppress bot in stage channel:', error);
      console.warn('[VoiceSession]', STAGE_SPEAK_PROMPT);
    }
  }

  // Connects to Gemini Live WebSocket and sets up callbacks
  async connectGemini({ reconnecting = false } = {}) {

    // Fetch guild object
    const guild = this.voiceChannel.guild;

    // Build context string for Gemini
    const { getGuildWideContext } = require('./memoryStore');

    // Fetch recent cross-channel context (async)
    // This gives the voice bot awareness of what's happening in text channels
    const guildContext = await getGuildWideContext(guild.id, { maxChannels: 3, timeWindowHours: 12 });

    const contextLines = [
      'Voice session metadata:',
      `- Server: ${guild.name} (${guild.id})`,
      `- Voice channel: ${this.voiceChannel.name} (${this.voiceChannel.id})`,
      `- Initiated by: ${this.initiatedBy.tag ?? this.initiatedBy.username} (${this.initiatedBy.id})`,
      'Mode context: Echo supports both text chat (/chat or mentioning @Echo in a text channel) and live voice chat (join a voice channel and run /join). You are currently in the live VOICE session, so respond with speech audio.',

      // Inject cross-channel awareness
      'RECENT SERVER ACTIVITY (Cross-channel context):',
      guildContext.contextString || 'No recent text activity found.',
      'Use this context to be aware of what users were discussing in text channels recently.',

      'LANGUAGE RULE: Always speak in English UNLESS the user explicitly speaks to you in another language first. If the user speaks Chinese/Spanish/etc, match their language. Otherwise, default to English.',
      'You are speaking live with multiple Discord users. Keep replies short, speech-friendly, and acknowledge the speaker by name when possible.',
      'Each turn should be a single concise spoken response — do not repeat the same sentence twice or restate the same idea back-to-back.',
      'IMPORTANT: In this Voice Mode, you CANNOT use tools (Search, etc). If asked to search or perform an action, politely explain you can only do that in Text Chat.',
      'End each spoken response cleanly—never repeat the final word or phrase out loud unless a user explicitly said it that way.',
      'TRANSCRIPT Log: For every turn, output a text summary of what the user said and your response. Do not output internal thought processes. Format: "User: [summary] | Echo: [response]"',
      CALL_END_INSTRUCTION,
    ].join('\n');

    // Add reconnection context with conversation history if reconnecting
    let finalContext = contextLines;
    if (reconnecting && this.conversationHistory.length > 0) {
      // Only inject context if last summary was within 5 minutes (avoid stale context)
      const timeSinceLastSummary = this.lastSummaryTimestamp ? Date.now() - this.lastSummaryTimestamp : Infinity;
      const FIVE_MINUTES = 5 * 60 * 1000;

      if (timeSinceLastSummary < FIVE_MINUTES) {
        // Build context string with max 400 chars total (to save tokens)
        const contextSnippet = this.conversationHistory.join('\n');
        const truncatedContext = contextSnippet.substring(0, 400);

        finalContext += '\n\n---PREVIOUS CONVERSATION (for context continuity)---\n';
        finalContext += truncatedContext;
        finalContext += '\n---END PREVIOUS CONVERSATION---\n';
        finalContext += 'Continue the conversation naturally from where it left off. Do not mention the reconnection.';

        console.log(`[VoiceSession] Injecting ${truncatedContext.length} chars of context from ${Math.round(timeSinceLastSummary / 1000)}s ago`);
      } else {
        console.log(`[VoiceSession] Skipping context injection (${Math.round(timeSinceLastSummary / 1000)}s since last summary, limit is 300s)`);
      }
    }

    // Connect to Gemini Live WebSocket
    this.liveSession = await connectLiveSession({
      extraPromptContext: finalContext,
      voiceName: this.voiceName, // Pass selected voice preset
      callbacks: {

        // Gemini Live connection established
        onopen: () => {
          debugVoice('Gemini Live link established.');

          // Send instructions on every connection (including reconnects)
          // This ensures Gemini knows about hangup detection even after auto-reconnect
          this.sendInitialInstructions();
        },
        // All Gemini logic flows through one handler
        onmessage: (message) => {
          this.handleServerMessage(message);
        },
        // Gemini Live error
        onerror: (error) => {
          console.error('[VoiceSession] Gemini Live error:', error);
        },
        // Gemini Live socket closed
        onclose: (event) => {
          console.log('[VoiceSession] onclose triggered! isReconnecting:', this.isReconnecting);

          // Defensive guard: prevent duplicate reconnection attempts from multiple close events
          if (this.isReconnecting) {
            console.log('[VoiceSession] Already reconnecting, ignoring duplicate close event');
            return;
          }

          const details = this.describeCloseEvent(event);
          console.warn('[VoiceSession] Gemini Live socket closed.', details);

          // Check if we should attempt reconnection
          if (this.shouldAttemptReconnect(event)) {
            console.log('[VoiceSession] Will attempt reconnection');
            void this.attemptReconnect(event);
          } else {
            console.log('[VoiceSession] Will NOT reconnect, destroying session');
            void this.destroy(`Gemini Live session closed${details ? ` (${details})` : ''}`);
          }
        },
      },
    });
  }

  // Sets up AudioStreamManager and UserAudioReceiver
  setupAudioManagers() {

    // Create audio stream manager (Gemini → Discord) for output
    this.audioStreamManager = new AudioStreamManager(this.audioPlayer);

    // Create user audio receiver (Discord → Gemini) for input
    this.userAudioReceiver = new UserAudioReceiver({
      connection: this.connection,
      botUserId: this.botUserId,

      // Callback: PCM audio chunk arrives from user → forward to Gemini
      onChunk: (pcmBuffer) => {
        this.forwardPcmChunk(pcmBuffer);
      },

      // Callback: Speaker switched → interrupt current conversation message and prevent cross-talk hallucinations
      onSpeakerChange: (newUserId) => {
        debugVoice('Speaker switch detected', { newUserId });
        this.signalAudioStreamEnd('speaker-switch');
      },

      // Callback: 750ms silence detected → end of current conversation message
      onSilence: () => {
        debugVoice('Silence detected, ending audio stream');
        this.signalAudioStreamEnd('silence');
        this.resetIdleTimer('user-silence');
      },
    });

    // Start listening to users
    this.userAudioReceiver.start();

    // Start idle timer
    this.resetIdleTimer('session-start');
  }

  /* RECONNECTION LOGIC */

  /**
   * Decides if we should attempt reconnection based on close event
   * 
   * @param {CloseEvent} event - WebSocket close event
   * @returns {boolean} - True if should reconnect
   */
  shouldAttemptReconnect(event) {

    // Don't reconnect if session is already destroyed
    if (this.destroyed) return false;

    // Don't reconnect if user explicitly requested hangup
    if (this.sessionEndRequested) return false;

    // Don't reconnect if we've exceeded max attempts
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return false;

    // Don't reconnect if it's a normal close (code 1000 from our side)
    if (event.code === 1000 && event.wasClean) return false;

    // Don't reconnect for code 1007 (Policy Violation - usually invalid configuration like wrong voice)
    if (event.code === 1007) {
      console.log('[VoiceSession] Code 1007 detected (invalid config), will NOT reconnect:', event.reason);
      return false;
    }

    // Reconnect for:
    // - code 1008 (Policy Violation - Gemini server issues)
    // - code 1006 (Abnormal Closure - network issues)
    // - Any other unexpected disconnection
    return true;
  }

  /**
   * Calculates exponential backoff delay based on attempt count
   * Formula: delay = Math.min(1000 * (2 ** attempt), 30000)
   * 
   * Attempts: 1s, 2s, 4s (capped at 30s)
   * 
   * @returns {number} - Delay in milliseconds
   */
  calculateBackoffDelay() {
    const baseDelay = 1000; // 1 second
    const maxDelay = 30000; // 30 seconds
    const delay = baseDelay * Math.pow(2, this.reconnectAttempts);
    return Math.min(delay, maxDelay);
  }

  /**
   * Attempts to reconnect to Gemini Live with exponential backoff
   * Uses loop-based retry instead of recursion for better control flow
   * 
   * @param {CloseEvent} event - Original close event
   */
  async attemptReconnect(event) {
    // Set reconnecting flag immediately
    this.isReconnecting = true;

    // Reset setup flag so new connection can initialize properly
    this.setupComplete = false;

    console.log('[VoiceSession] Starting reconnection attempts...');

    // Loop-based retry instead of recursion
    while (this.reconnectAttempts < this.maxReconnectAttempts && !this.destroyed) {
      this.reconnectAttempts++;

      const delay = this.calculateBackoffDelay();
      const attemptNum = this.reconnectAttempts;
      const maxAttempts = this.maxReconnectAttempts;

      console.log(`[VoiceSession] Reconnection attempt ${attemptNum}/${maxAttempts} in ${delay}ms...`);

      // Notify user in Discord
      await this.notifyReconnectAttempt(attemptNum, maxAttempts, delay);

      // Wait for backoff delay
      await new Promise(resolve => {
        this.reconnectTimeoutHandle = setTimeout(resolve, delay);
      });

      // Check if session was destroyed during wait
      if (this.destroyed) {
        console.log('[VoiceSession] Session destroyed during reconnect wait, aborting');
        this.isReconnecting = false;
        return;
      }

      try {
        // Close old session cleanly
        if (this.liveSession) {
          try {
            await this.liveSession.close();
          } catch (e) {
            // Ignore errors closing dead session
          }
          this.liveSession = null;
        }

        // Attempt new connection with reconnecting flag
        await this.connectGemini({ reconnecting: true });

        // Success! Exit loop
        console.log('[VoiceSession] Reconnection successful!');
        this.isReconnecting = false;

        // Only reset attempts after 10 seconds of stability
        // This prevents infinite "1/3" loops if the connection opens but immediately crashes again
        setTimeout(() => {
          if (!this.isReconnecting && !this.destroyed) {
            this.reconnectAttempts = 0;
            debugVoice('Connection stable, reset reconnect attempts');
          }
        }, 10_000);

        // Notify user
        await this.notifyReconnectSuccess();

        // Exit loop on success
        return;

      } catch (error) {
        console.error(`[VoiceSession] Reconnection attempt ${attemptNum} failed:`, error);

        // Continue to next iteration if we have more attempts
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          // Max attempts reached, exit loop
          break;
        }
      }
    }

    // If we get here, all retries failed
    console.error('[VoiceSession] Max reconnection attempts reached, destroying session');
    this.isReconnecting = false;
    await this.notifyReconnectFailed();
    await this.destroy('Failed to reconnect after multiple attempts');
  }

  /**
   * Notifies user about reconnection attempt
   * 
   * @param {number} attemptNum - Current attempt number
   * @param {number} maxAttempts - Max attempts allowed
   * @param {number} delay - Delay before retry (ms)
   */
  async notifyReconnectAttempt(attemptNum, maxAttempts, delay) {
    try {
      const delaySec = Math.round(delay / 1000);
      await this.voiceChannel.send(
        `Connection lost. Reconnecting... (Attempt ${attemptNum}/${maxAttempts}, waiting ${delaySec}s)`
      );
    } catch (error) {
      // Silently ignore Discord API errors (rate limits, permissions)
      console.warn('[VoiceSession] Failed to send reconnect notification:', error.message);
    }
  }

  // Notifies user about successful reconnection
  async notifyReconnectSuccess() {
    try {
      await this.voiceChannel.send('Reconnected! Conversation resumed.');
    } catch (error) {
      console.warn('[VoiceSession] Failed to send success notification:', error.message);
    }
  }

  // Notifies user about failed reconnection
  async notifyReconnectFailed() {
    try {
      await this.voiceChannel.send(
        'Failed to reconnect. Use `/join` to start a new session.'
      );
    } catch (error) {
      console.warn('[VoiceSession] Failed to send failure notification:', error.message);
    }
  }

  /* GEMINI COMMUNICATIONS */

  // Sends initial instructions to Gemini when WebSocket opens
  // "primes" the model for Silent Guardian mode
  sendInitialInstructions() {

    // If no live session, do nothing
    if (!this.liveSession) return;

    try {
      this.liveSession.sendClientContent({ // For conversation context/text, not audio stream
        turns: [ // Gemini Live expects turn-structured input
          {
            role: 'user',
            parts: [
              {
                text: `You are Echo, a "Silent Guardian" in a group voice chat.
${CALL_END_INSTRUCTION}

YOUR BEHAVIOR:
1. MONITOR MODE (Default): Listen silently. Do NOT reply to casual conversation, banter, laughter, or gaming excitement.
2. INTERVENTION MODE: Speak ONLY if you detect:
   - Genuine AGGRESSION (shouting, threats, personal attacks)
   - SAFETY RISKS (self-harm, doxxing, harassment)
   - Direct requests for help (e.g. "Echo, help", "Echo, stop them")

If you intervene:
- Be brief (under 15 words).
- Be calm and authoritative.
- Example: "Let's pause and take a breath, everyone."
- Do NOT be chatty. Do NOT try to join the conversation.

If the conversation is safe, stay silent.`,
              },
            ],
          },
        ],
      });
      debugVoice('Sent "Silent Guardian" instructions to Gemini');
    } catch (err) { // Error handling for synchronous WebSocket send failures
      console.error('[VoiceSession] Failed to seed live session:', err);
    }
  }

  // Forwards a PCM audio chunk to Gemini
  // NOTE: This is a pass-through stream. Audio is NOT stored.
  // The buffer is immediately forwarded to the API and then dereferenced.
  processAudioFrame(pcmBuffer) {
    if (!this.liveSession) return;

    try {
      this.liveSession.sendRealtimeInput([{
        mimeType: "audio/pcm;rate=16000",
        data: pcmBuffer.toString("base64")
      }]);
      // Explicitly noting that we do not save the buffer
      // debugVoice('Audio chunk processed (Ephemeral: Not Stored)'); 
    } catch (err) {
      console.error('[VoiceSession] Failed to send audio frame:', err);
    }
  }
  // VoiceSession does not care who spoke, just forwards raw audio stream
  // @param {Buffer} chunk - PCM audio data (48kHz mono) 
  forwardPcmChunk(chunk) {

    // If sockets closed or destroyed, do nothing to prevent race conditions after shutdown
    if (!this.liveSession || this.destroyed) {
      return;
    }

    try {
      // Converts raw buffer to base64-encoded audio (expected by Gemini)
      const base64Data = chunk.toString('base64');

      // Sends the chunk to Gemini Live's real time streaming channel
      this.liveSession.sendRealtimeInput({
        audio: {
          mimeType: PCM_MIME_TYPE, // Explicitly declares PCM audio (sample rate=48kHz, mono)
          data: base64Data, // Actual payload
        },
      });
    } catch (error) { // Error handling for send failures
      console.error('[VoiceSession] Failed to stream PCM chunk to Gemini:', error); // Log error but no retry, no buffer
    }
  }

  // Signals end of audio stream to Gemini (tells it that user finished speaking)
  // @param {string} context - Reason for ending (e.g., 'silence', 'speaker-switch')
  signalAudioStreamEnd(context = 'manual') {

    // If sockets closed or destroyed, do nothing to prevent race conditions after shutdown
    if (!this.liveSession || this.destroyed) {
      return;
    }

    try {
      // Logs why a conversation message ended
      debugVoice('Signaling Gemini audioStreamEnd', { context });

      // Sends end signal to Gemini to trigger response NOW
      this.liveSession.sendRealtimeInput({ audioStreamEnd: true });

    } catch (error) { // Error handling for WebSocket failures
      console.error('[VoiceSession] Failed to signal audioStreamEnd:', error);
    }
  }

  /* MESSAGE HANDLING (GEMINI → BOT) */

  // Handles a message from Gemini Live WebSocket (act as single ingress point)
  // (e.g., audio response, summaries, control signals...)

  /* 
    Message types:
    - setupComplete: Gemini is ready
    - goAway: Gemini requests disconnect
    - serverContent: Audio/text response from Gemini
  */
  handleServerMessage(message) {
    // Handle setup complete (acknowledge handshake)
    // Gemini sends this once ready to receive input
    if (message.setupComplete) {
      this.setupComplete = true;
    }

    // Handle goAway (server requests disconnect)
    // Gemini Live Preview has a turn limit (~3-5 turns), after which it sends goAway
    // Instead of destroying the session, we reconnect to continue the conversation
    if (message.goAway) {
      const reason = message.goAway?.reason || 'server requested disconnect';
      console.log('[VoiceSession] Gemini server requested disconnect:', reason);
      console.log('[VoiceSession] Auto-reconnecting to continue conversation...');

      // Trigger reconnection instead of destroying
      // This preserves the Discord voice connection and conversation context
      void this.handleReconnect({
        code: 1008, // Policy Violation (server-initiated)
        reason: `goAway: ${reason}`,
        wasClean: false
      });
      return;
    }

    // Handle server content (responses)
    // Only process messages that contain actual model output, ignore other types
    const rawContent = message.serverContent;

    // If no model output, do nothing
    if (!rawContent) return;

    // Normalizes single or batch responses, Gemini can send either one
    const contents = Array.isArray(rawContent) ? rawContent : [rawContent];

    // Debug logging
    debugVoice('Received serverContent batch', contents.length);

    // Process each response fragment independently
    for (const content of contents) {
      if (!content) continue;

      // Stops audio output when Gemini self-interrupts (changes its mind mid-speech, new responses override old ones)
      // Prevents overlapping audio output
      if (content.interrupted) {
        this.audioStreamManager?.flush();
      }

      // Extract model turn (Gemini's response), normalizes old and new formats
      const modelTurn = content.modelTurn ?? content;

      // Proceed only when there are actual parts
      if (modelTurn?.parts?.length) {
        this.logModelTurnParts(modelTurn);

        // Delegates each part to appropriate handler
        // - Text parts → summary/hangup detection
        // - Audio parts → AudioStreamManager
        for (const part of modelTurn.parts) {
          this.handleModelPart(part);
        }
      }

      // Close the current audio output and prepare for next turn at end of response
      // Prevents stream leakage and ensure proper concatenation of audio chunks
      if (content.turnComplete) {
        debugVoice('Turn complete signaled.');
        this.audioStreamManager?.closeStream();

        // If hangup was requested, only disconnect AFTER audio finishes
        // Ensures bot replies are fully played before disconnecting
        if (this.sessionEndRequested) {
          console.log('[VoiceSession] Hangup requested, waiting for goodbye to finish...');
          this.scheduleDestroyAfterPlayback('User requested hangup');
        }
      }
    }

    // Reset idle timer (60 seconds) to prevent session from timing out
    this.resetIdleTimer('model-response');
  }

  // Logs model turn parts for debugging (e.g., duplicate audio, unexpected text parts, missing summaries...)
  // @param {Object} modelTurn - Gemini model turn
  logModelTurnParts(modelTurn) {

    // Debugging disabled or no parts for performance and schema safety
    if (!DEBUG_GEMINI_VOICE || !modelTurn?.parts) {
      return;
    }

    // Maps each raw Gemini part to a descriptor/readable String (text/audio/other)
    const descriptors = modelTurn.parts.map((part) => {

      // Handle text part (e.g. summaries, hangup detection)
      if (part?.text) {
        const preview = part.text.length > 60 ? `${part.text.slice(0, 57)}...` : part.text;
        return `text:"${preview}"`;
      }

      // Handle audio part (e.g. speech, partial audio outputs)
      if (part?.inlineData?.data) {
        const size = part.inlineData.data.length; // Base64 size
        return `audio:${part.inlineData.mimeType || 'unknown'} (${size}b base64)`;
      }

      // Handle other part (in case future Gemini schema changes)
      return 'other-part';
    });

    // Final debug logging
    debugVoice('Model turn parts', descriptors.join(', '));
  }

  /**
   * Handles a single part of Gemini's response (text or audio).
   * Do not mix the rules: text controls session, audio goes to output.
   * 
   * @param {Object} part - Gemini response part
   * @param {string} [part.text] - Text content (summary)
   * @param {Object} [part.inlineData] - Audio data
   */
  handleModelPart(part) {

    // Early return if no part to prevent malformed streams causing errors
    if (!part) return;

    // Handle text part (summary) - check for hangup keyword
    if (part.text) {
      this.handleTextPart(part.text);
    }

    // Handle audio part (speech)
    if (part.inlineData?.data) {
      // Converts base64 PCM from Gemini to raw PCM buffer
      const buffer = Buffer.from(part.inlineData.data, 'base64');

      // Write to audio stream manager which handles de-duplication, backpressure etc.
      // VoiceSessionManager never plays audio directly
      this.audioStreamManager?.writeChunk(buffer, part.inlineData.mimeType);
    }
  }

  // Handles a text part from Gemini (usually a summary)
  // Checks for hangup keyword in summary
  // Updates ServerState for cross-modal intelligence
  // @param {string} text - Text content
  async handleTextPart(text) {

    // Early return if no text
    const trimmed = text.trim();
    if (!trimmed) return;

    // Store summary in conversation history (keep last 3 for reconnection context)
    // Truncate to 100 chars each to limit token usage (max 300 chars total)
    this.conversationHistory.push(`- ${trimmed.substring(0, 100)}`);
    if (this.conversationHistory.length > 3) {
      this.conversationHistory.shift(); // Remove oldest
    }
    // Track timestamp for time-based filtering
    this.lastSummaryTimestamp = Date.now();

    // Check for hangup keyword in summary
    // This approach is cheaper than transcription and not affected by speech pronunciation
    // Also catch meta-commentary if Gemini describes terminating but forgets the token
    const lowerTrimmed = trimmed.toLowerCase();
    if (trimmed.includes(HANGUP_KEYWORD) ||
      lowerTrimmed.includes('initiating protocol termination') ||
      lowerTrimmed.includes('session termination') ||
      lowerTrimmed.includes('termination token') ||
      lowerTrimmed.includes('terminating session') ||
      lowerTrimmed.includes('ending the session') ||
      lowerTrimmed.includes('closing the connection') ||
      lowerTrimmed.includes('prioritizing disconnection') ||
      lowerTrimmed.includes('hangup protocol') ||
      lowerTrimmed.includes('terminate the session') ||
      lowerTrimmed.includes('appropriate token') // Catches "with the appropriate token"
    ) {
      console.log('[VoiceSession] Hangup detected in summary:', trimmed);

      // Set flag to ensure actual disconnect will happen on turnComplete, do not goodbye halfway when audio isnt finished 
      this.sessionEndRequested = true;
      return;
    }

    // Log summary for debugging
    debugVoice('Gemini summary:', trimmed);
    console.log('[VoiceSession] Gemini summary:', {
      guildId: this.voiceChannel.guild.id,
      channelId: this.voiceChannel.id,
      summary: trimmed,
    });


    // Update ServerState with voice summary to bridge voice intelligence with the intervention planner
    // Voice summaries are more urgent as they capture real-time emotion
    try {
      // Lazy load dependencies
      const { updateServerState, getServerState, checkTriggers } = require('./core/server-state');
      const { getGeminiClient } = require('./gemini-client');
      const { GEMINI_TEXT_MODEL } = require('./config/models');

      // Analyze voice summary for sentiment (enables conflict detection in voice)
      let voiceMoodScore = null;
      try {
        const ai = getGeminiClient();
        const sentimentPrompt = `Analyze the emotional tone of this voice conversation summary and return ONLY a number between -1.0 (very negative/tense) and 1.0 (very positive/happy).

Summary: "${trimmed}"

Return only the number, nothing else. Examples:
- Friendly greeting: 0.3
- Stressed about deadline: -0.6
- Excited celebration: 0.8
- Neutral discussion: 0.0`;

        const result = await ai.models.generateContent({
          model: GEMINI_TEXT_MODEL,
          contents: [{ role: 'user', parts: [{ text: sentimentPrompt }] }],
        });

        const scoreText = result.text?.trim();
        const parsedScore = parseFloat(scoreText);

        if (!isNaN(parsedScore) && parsedScore >= -1.0 && parsedScore <= 1.0) {
          voiceMoodScore = parsedScore;
          debugVoice(`Voice sentiment analyzed: ${voiceMoodScore}`);
        } else {
          debugVoice(`Invalid sentiment score: ${scoreText}`);
        }
      } catch (sentimentErr) {
        // Non-critical: sentiment analysis failure shouldn't break voice session
        debugVoice('Voice sentiment analysis failed:', sentimentErr.message);
      }

      // Append to session buffer to maintain context (Goldfish Memory -> Session Memory)
      // We keep the last 1000 characters of the conversation to ensure early commitments (like deadlines) aren't overwritten
      if (this.sessionSummaryBuffer) {
        this.sessionSummaryBuffer += ' | ' + trimmed;
      } else {
        this.sessionSummaryBuffer = trimmed;
      }

      // Cap at 5000 chars to handle more conversation history in voice
      if (this.sessionSummaryBuffer.length > 5000) {
        this.sessionSummaryBuffer = '...' + this.sessionSummaryBuffer.slice(this.sessionSummaryBuffer.length - 4997);
      }

      // Update state with voice summary and analyzed mood
      const updates = {
        lastVoiceSummary: this.sessionSummaryBuffer,
        lastVoiceTimestamp: new Date(),
        source: 'voice',
      };

      // If we successfully analyzed sentiment, include it
      if (voiceMoodScore !== null) {
        updates.moodScore = voiceMoodScore;
        updates.confidence = 0.7; // Voice sentiment is slightly less precise than text batch analysis
      }

      const state = await updateServerState(this.voiceChannel.guild.id, updates);

      debugVoice('Updated ServerState with voice summary');

      // Check for triggers immediately (Voice tension -> Text intervention)
      const triggers = checkTriggers(state);

      // Manual Safety Trigger (Segment-based)
      // We removed the full-history scan from server-state.js to prevent duplicates.
      // Now we assume if the current chunk mentions danger, it's urgent.
      // Multilingual: EN + ZH + ES + JP common terms
      const safetyKeywords = [
        // English
        'stalk', 'suicid', 'self-harm', 'harassment', 'call the police', 'danger', 'kill', 'die',
        // Chinese
        '自杀', '跟踪', '死', '杀', '骚扰', '想死', '不想活',
        // Spanish
        'suicidio', 'acoso', 'matar',
        // Japanese
        '自殺', 'ストーカー', '殺'
      ];
      if (safetyKeywords.some(kw => trimmed.toLowerCase().includes(kw))) {
        console.log('[VoiceSession] Urgent Safety Keyword detected in live segment:', trimmed);
        // Force push SAFETY_RISK if not already present
        if (!triggers.includes('SAFETY_RISK')) {
          triggers.push('SAFETY_RISK');
        }
      }

      // Set context markers for anticipatory reasoning
      // This influences future decisions without any visible action
      if (voiceMoodScore !== null && voiceMoodScore < -0.3) {
        try {
          const { setContextMarker } = require('./core/server-state');
          await setContextMarker(this.voiceChannel.guild.id, {
            type: 'voice_tension',
            confidence: Math.abs(voiceMoodScore), // Higher negative = higher confidence
            topic: state.dominantTopics?.[0] || 'unspecified',
            ttlMs: 20 * 60 * 1000, // 20 minutes
          });
          console.log(`[VoiceSession] Context marker set: voice_tension (mood: ${voiceMoodScore})`);
        } catch (markerErr) {
          console.error('[VoiceSession] Failed to set context marker:', markerErr.message);
        }
      }

      // Echo interjects in voice chat and speaks to de-escalate tension
      // Only trigger if mood is significantly negative and cooldown expired
      const humanCount = this.voiceChannel.members.filter(m => !m.user.bot).size;
      if (voiceMoodScore !== null && voiceMoodScore < -0.6 && !this.recentInterjection && humanCount > 1) {
        // Set cooldown: only one interjection per 3 minutes
        this.recentInterjection = Date.now();
        setTimeout(() => { this.recentInterjection = null; }, 180000);

        // Fire and forget - inject calming interjection
        this.injectVoiceInterjection('stress_detected', trimmed).catch(err =>
          console.error('[VoiceSession] Voice interjection error:', err.message)
        );
      } else if (voiceMoodScore < -0.6 && humanCount <= 1) {
        debugVoice('Skipping interjection: only 1 human in channel');
      }

      // Decision Capture: Detect and capture decisions from voice summaries
      if (!this.recentDecisionCapture) {
        // Fire and forget - let Gemini decide if this contains a decision
        this.captureDecision(trimmed).catch(err =>
          console.error('[VoiceSession] Decision capture error:', err.message)
        );
      }

      if (triggers.length > 0) {
        console.log(`[VoiceSession] Triggers detected from voice: ${triggers.join(', ')}`);

        try {
          const { triggerIntervention } = require('./core/intervention-planner');
          // Fire and forget - don't await, let it run in background so voice doesn't lag
          triggerIntervention(this.voiceChannel.guild.id, triggers, state)
            .catch(err => console.error('[VoiceSession] Intervention planner error:', err));
        } catch (plannerErr) {
          console.error('[VoiceSession] Failed to load intervention planner:', plannerErr);
        }
      }

    } catch (stateErr) {
      // ServerState update should not break voice session
      console.error('[VoiceSession] Failed to update ServerState:', stateErr.message);
    }
  }

  /**
   * Decision Capture: Extract and post decisions from voice summaries
   * Uses Gemini to extract the decision, then posts to text channel
   * @param {string} summary - Voice conversation summary containing a decision
   */
  async captureDecision(summary) {
    try {
      const { getGeminiClient } = require('./gemini-client');
      const { GEMINI_TEXT_MODEL } = require('./config/models');
      const { getDiscordClient, isClientReady } = require('./discord-client');
      const { findBestChannel } = require('./core/intervention-planner');
      const { setContextMarker } = require('./core/server-state');

      const ai = getGeminiClient();

      // Extract decision using Gemini - intelligent detection, works for any language
      const extractPrompt = `
Analyze this voice conversation summary. Extract ONLY if there is a CLEAR TEAM DECISION or AGREEMENT.

A decision must be:
- An actionable commitment (not just a suggestion or question)
- Agreed upon or confirmed by the group
- Specific enough to act on

Return ONLY valid JSON:
{ "decision": "brief actionable decision", "confidence": 0.0-1.0 }

If NO clear decision, return: { "decision": null, "confidence": 0 }

DECISION examples (confidence 0.8+):
- "We agreed to fix the bug first" → { "decision": "Fix bug before new features", "confidence": 0.9 }
- "Okay let's use React" → { "decision": "Use React for frontend", "confidence": 0.85 }

NOT a decision (confidence 0):
- "We should probably..." (just a suggestion)
- "What if we..." (question)
- "That sounds good" (acknowledgment without action)
- Casual chat about weekend plans

Summary: "${summary.slice(0, 500)}"
`;

      const result = await ai.models.generateContent({
        model: GEMINI_TEXT_MODEL,
        contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      });

      // Parse the decision
      let decision, confidence;
      try {
        const parsed = JSON.parse(result.text);
        decision = parsed.decision;
        confidence = parsed.confidence || 0;
      } catch (parseErr) {
        debugVoice('Failed to parse decision JSON:', result.text);
        return;
      }

      // Only post if we have a clear decision with high confidence
      if (!decision || confidence < 0.7) {
        debugVoice('No clear decision detected or low confidence:', { decision, confidence });
        return;
      }

      // Set cooldown BEFORE posting to prevent race conditions
      // 2 minute cooldown to avoid decision spam
      this.recentDecisionCapture = Date.now();
      setTimeout(() => { this.recentDecisionCapture = null; }, 120000);

      // Post to Discord
      if (!isClientReady()) {
        console.warn('[VoiceSession] Discord client not ready, skipping decision capture');
        return;
      }

      const client = getDiscordClient();
      const guild = client.guilds.cache.get(this.voiceChannel.guild.id);

      if (!guild) {
        console.warn('[VoiceSession] Guild not found for decision capture');
        return;
      }

      const targetChannel = findBestChannel(guild);
      if (!targetChannel) {
        console.warn('[VoiceSession] No suitable channel for decision capture');
        return;
      }

      // Post the decision with a clear format
      const message = `📋 **Decision captured from voice:** ${decision}`;
      await targetChannel.send(message);

      console.log(`[VoiceSession] Decision captured and posted to #${targetChannel.name}: "${decision}"`);

      // Also set a context marker for future reference
      await setContextMarker(this.voiceChannel.guild.id, {
        type: 'decision_made',
        topic: decision,
        confidence,
        ttlMs: 60 * 60 * 1000, // 1 hour TTL for decisions
      });

    } catch (err) {
      console.error('[VoiceSession] Decision capture failed:', err.message);
    }
  }

  /**
   * Voice Interjection: Inject a spoken message into the voice stream
   * Forces Echo to speak out loud to de-escalate tension
   * @param {string} type - Type of interjection (stress_detected, clarification, etc.)
   * @param {string} context - Context string for logging
   */
  async injectVoiceInterjection(type, context) {
    if (!this.liveSession) return;

    const interjections = {
      stress_detected: `Hey, quick check-in — sounds like there's some pressure here. Want me to help summarize where things stand?`,
      clarification_needed: `Just to make sure I'm following — it sounds like there are two different approaches being discussed. Am I hearing that right?`,
      decision_prompt: `It sounds like you're close to a decision. Want me to capture that so everyone's on the same page?`
    };

    const message = interjections[type] || interjections.stress_detected;

    console.log(`[VoiceSession] Injecting voice interjection (${type}): "${message}"`);
    debugVoice('Interjection context:', context);

    try {
      // Send as text input to Gemini Live - it will speak it out loud
      // Add [SYSTEM] to make sure Gemini knows it's an instruction to speak
      this.liveSession.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{ text: `[SYSTEM] Speak this naturally to the users now: "${message}"` }]
        }]
      });
    } catch (err) {
      console.error('[VoiceSession] Failed to inject voice interjection:', err.message);
    }
  }

  /* SESSION MANAGEMENT */

  // Schedules session destruction after current audio finishes playing
  // Polls audio player status until idle
  // Ensures bot finishes speaking before disconnecting
  // @param {string} reason - Reason for destroying session
  scheduleDestroyAfterPlayback(reason = 'Session ended.') {

    // Early return if already destroyed
    if (this.destroyed) return;

    // Set reason for destruction (e.g., hangup, idle), last meaningful reason wins
    this.pendingDestroyReason = reason || this.pendingDestroyReason || 'Session ended.';

    // Prevents multiple polling loops
    if (this.destroyAfterPlaybackHandle) {
      return;
    }

    // Polls audio player status until idle
    // Chosen instead of events because Discord audio player state can be racy (e.g., early or sudden disconnects, cut off speech)
    // Polling is more reliable because audio is not destroyed while playing
    const pollPlayback = () => {

      // Early return if destroyed externally (e.g., user left)
      if (this.destroyed) {
        this.destroyAfterPlaybackHandle = null;
        return;
      }

      // Under normal execution, clear old timer reference
      this.destroyAfterPlaybackHandle = null;

      // Check if audio player is idle
      const playerState = this.audioPlayer?.state;
      const playerIdle = !playerState || playerState.status === AudioPlayerStatus.Idle;

      // Destroy session if player is idle
      if (playerIdle) {
        const finalReason = this.pendingDestroyReason || reason;
        this.pendingDestroyReason = null;
        void this.destroy(finalReason);
        return;
      }

      // Still playing, check again in 250ms (fast enough to feel instant but slow enough to prevent CPU churn)
      this.destroyAfterPlaybackHandle = setTimeout(pollPlayback, 250);
    };

    pollPlayback();
  }

  // Destroys the voice session and cleans up all resources
  // @param {string} reason - Reason for destruction (for logging)
  async destroy(reason) {

    // Early return if already destroyed to prevent double frees, websocket errors
    if (this.destroyed) return;
    this.destroyed = true;

    console.log(`[VoiceSession] Destroying session: ${reason}`);

    // Clear timers to prevent memory leaks and late callbacks
    if (this.destroyAfterPlaybackHandle) {
      clearTimeout(this.destroyAfterPlaybackHandle);
      this.destroyAfterPlaybackHandle = null;
    }
    if (this.goodbyeTimeoutHandle) {
      clearTimeout(this.goodbyeTimeoutHandle);
      this.goodbyeTimeoutHandle = null;
    }

    // Clear reconnection timer and reset state
    if (this.reconnectTimeoutHandle) {
      clearTimeout(this.reconnectTimeoutHandle);
      this.reconnectTimeoutHandle = null;
    }
    this.isReconnecting = false;
    this.reconnectAttempts = 0;

    this.clearIdleTimer();

    // Remove stale session from sessions map to ensure new /join can start a new session immediately
    sessions.delete(this.voiceChannel.id);

    // Delegate cleanup to respective managers
    this.audioStreamManager?.destroy();
    this.userAudioReceiver?.destroy();

    // Stop audio player to clear buffers and prevent lingering output
    try {
      if (this.audioPlayer) {
        this.audioPlayer.stop(true);
      }
    } catch (error) {
      console.error('[VoiceSession] Failed to stop audio player:', error);
    }

    // Destroy voice connection from Discord
    try {
      if (this.connection) {
        this.connection.destroy();
      }
    } catch (error) {
      console.error('[VoiceSession] Failed to destroy voice connection:', error);
    }

    // Close Gemini websocket session cleanly
    try {
      if (this.liveSession) {
        this.liveSession.close();
      }
    } catch (error) {
      console.error('[VoiceSession] Failed to close Gemini session:', error);
    }
  }

  /* IDLE TIMEOUT */

  // Resets the idle timeout (60 seconds of inactivity → disconnect)
  // Called whenever there's activity (user speaks, bot responds)
  // Prevents forgotten silent sessions and resource leaks
  // @param {string} context - What triggered the reset (for debugging)
  resetIdleTimer(context = 'default') {

    // Clear existing timer if it exists, can be triggered by user or bot
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }

    // Set new timer
    this.idleTimer = setTimeout(() => {
      console.warn('[VoiceSession] Idle timeout reached, ending session');

      // Notify voice channel (if possible)
      if (this.voiceChannel && this.voiceChannel.send) {
        this.voiceChannel.send('⏳ Left voice channel due to inactivity (1 minute of silence).')
          .catch(err => console.error('[VoiceSession] Failed to send timeout message:', err));
      }

      // Destroy session
      void this.destroy('Idle timeout (60s silence).');
    }, IDLE_TIMEOUT_MS);

    // Debug logging
    debugVoice('Idle timer reset', { context, timeoutMs: IDLE_TIMEOUT_MS });
  }

  // Clears the idle timeout timer
  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /* PERIODIC CONFLICT ANALYSIS */

  /**
   * Starts the periodic background analysis timer
   * This runs every 45 seconds to detect conflicts during continuous conversations
   * without interrupting the voice stream
   */
  startPeriodicAnalysis() {

    // Clear any existing timer
    if (this.periodicAnalysisTimer) {
      clearInterval(this.periodicAnalysisTimer);
    }

    // Start the periodic analysis timer
    this.periodicAnalysisTimer = setInterval(() => {
      // Only run if session is active and not destroyed
      if (!this.destroyed && !this.isReconnecting) {
        void this.runPeriodicConflictAnalysis();
      }
    }, PERIODIC_ANALYSIS_INTERVAL_MS);

    debugVoice('Started periodic conflict analysis timer', { intervalMs: PERIODIC_ANALYSIS_INTERVAL_MS });
  }

  /**
   * Runs background conflict analysis on accumulated voice summaries
   * This uses a SEPARATE Gemini API call (not the voice stream) to analyze
   * the conversation without interrupting users
   */
  async runPeriodicConflictAnalysis() {
    // Skip if no accumulated summary to analyze
    if (!this.sessionSummaryBuffer || this.sessionSummaryBuffer.length < 50) {
      debugVoice('Skipping periodic analysis: insufficient buffer');
      return;
    }

    // Skip if buffer hasn't changed since last analysis (avoid duplicate work)
    if (this.sessionSummaryBuffer === this.lastPeriodicAnalysisBuffer) {
      debugVoice('Skipping periodic analysis: buffer unchanged');
      return;
    }

    try {
      debugVoice('Running periodic conflict analysis...');

      // Mark buffer as analyzed
      this.lastPeriodicAnalysisBuffer = this.sessionSummaryBuffer;

      // Lazy load dependencies
      const { getGeminiClient } = require('./gemini-client');
      const { GEMINI_TEXT_MODEL } = require('./config/models');
      const { updateServerState, checkTriggers, setContextMarker } = require('./core/server-state');

      const ai = getGeminiClient();

      // Analyze the accumulated conversation for conflict indicators
      const analysisPrompt = `Analyze this voice conversation excerpt and identify if there are signs of:
1. CONFLICT: Disagreement, arguing, raised tensions between participants
2. STRESS: Someone under pressure, frustrated, or overwhelmed
3. HELP_REQUEST: Someone asking for help or in distress

Conversation excerpt:
"${this.sessionSummaryBuffer.slice(-1000)}"

Respond in this EXACT JSON format:
{
  "hasConflict": true/false,
  "conflictConfidence": 0.0-1.0,
  "hasStress": true/false,
  "stressConfidence": 0.0-1.0,
  "hasHelpRequest": true/false,
  "overallMood": -1.0 to 1.0 (negative = tense, positive = friendly),
  "summary": "brief 10-word description of the conversation tone"
}

Return ONLY the JSON, no explanation.`;

      const result = await ai.models.generateContent({
        model: GEMINI_TEXT_MODEL,
        contents: [{ role: 'user', parts: [{ text: analysisPrompt }] }],
      });

      // Parse the JSON response
      const responseText = result.text?.trim() || '';
      let analysis;
      try {
        // Extract JSON from response (in case there's extra text)
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
      } catch (parseErr) {
        debugVoice('Failed to parse periodic analysis response:', responseText);
        return;
      }

      if (!analysis) return;

      console.log('[VoiceSession] Periodic analysis result:', analysis);

      // Update server state with analysis results
      const guildId = this.voiceChannel.guild.id;

      // Update mood if we got a valid score
      if (typeof analysis.overallMood === 'number') {
        await updateServerState(guildId, {
          moodScore: analysis.overallMood,
          source: 'voice',
          confidence: 0.6, // Lower confidence than real-time analysis
        });
      }

      // Set context markers for detected issues
      if (analysis.hasConflict) {
        // High Confidence (>0.8) -> Active Voice Intervention
        if (analysis.conflictConfidence >= 0.8) {
          console.log(`[VoiceSession] 🔴 HIGH CONFLICT DETECTED (Conf: ${analysis.conflictConfidence}). Queuing Voice Intervention.`);
          this.queueVoiceIntervention("Let's pause for a moment. Things are getting heated.");
        }

        // Moderate Confidence (>0.4) -> Record marker
        if (analysis.conflictConfidence >= 0.4) {
          await setContextMarker(guildId, {
            type: 'voice_tension',
            confidence: analysis.conflictConfidence,
            topic: analysis.summary || 'voice conflict detected',
            ttlMs: 15 * 60 * 1000, // 15 minutes
          });
        }
      }

      if (analysis.hasStress && analysis.stressConfidence >= 0.4) {
        await setContextMarker(guildId, {
          type: 'high_stress_period',
          confidence: analysis.stressConfidence,
          topic: analysis.summary || 'stress detected in voice',
          ttlMs: 20 * 60 * 1000, // 20 minutes
        });
      }

      // Check if text intervention needed (Standard Logic)
      // This handles the "Post Summary" part automatically if triggers exist
      const state = await require('./core/server-state').getServerState(guildId);
      const triggers = checkTriggers(state);

      if (triggers.length > 0) {
        debugVoice('Periodic analysis found triggers:', triggers);

        // Execute intervention (posts to text channel if needed) 
        const { triggerIntervention } = require('./core/intervention-planner');
        await triggerIntervention(guildId, triggers, state);
      }

    } catch (err) {
      // Non-critical: periodic analysis failure shouldn't break voice session
      console.error('[VoiceSession] Periodic conflict analysis failed:', err.message);
    }
  }

  /**
   * Safely injects a voice message (VAD-Aware)
   * Only speaks if NO ONE is currently speaking to avoid rude interruptions
   * @param {string} content - What the bot should say
   */
  queueVoiceIntervention(content) {
    if (!this.liveSession) return;

    // VAD Check: If anyone is speaking, ABORT intervention (Silent Guardian rule)
    // We rely on UserAudioReceiver's activeSpeaker tracking
    const isUserSpeaking = this.userAudioReceiver && this.userAudioReceiver.activeSpeaker;

    if (isUserSpeaking) {
      debugVoice('⚠️ Skipping Voice Intervention: User is speaking.', { user: this.userAudioReceiver.activeSpeaker });
      return;
    }

    try {
      debugVoice('🗣️ Injecting Voice Intervention:', content);
      this.liveSession.sendClientContent({
        turns: [{
          role: 'user',
          parts: [{
            text: `SYSTEM COMMAND: Please say the following phrase exactly, with a calm, authoritative, de-escalating tone: "${content}"`
          }]
        }]
      });
    } catch (err) {
      console.error('[VoiceSession] Failed to inject voice intervention:', err);
    }
  }

  /* HELPERS */

  // Generates a human-readable description of a WebSocket close event (e.g., "code 1000, reason 'normal'")
  describeCloseEvent(event) {

    // If no event, return empty string
    if (!event) return '';

    // Build description parts
    const parts = [];

    // Add code if available (e.g. "code 1008")
    if (typeof event.code === 'number') {
      parts.push(`code ${event.code}`);
    }

    // Add reason if available (e.g. "reason 'normal'")
    if (event.reason) {
      parts.push(`reason "${event.reason}"`);
    }

    // Return joined parts with comma and space (e.g. "code 1008, reason 'normal'")
    return parts.join(', ');
  }
}

/* SESSION MANAGEMENT FUNCTIONS */

// Starts a new voice session in the given channel
async function startVoiceSession({ voiceChannel, initiatedBy, voiceName }) {

  // Prevent multiple Gemini sessions in the same channel
  if (sessions.has(voiceChannel.id)) {
    const existing = sessions.get(voiceChannel.id);
    // Check if session is currently reconnecting
    if (existing?.isReconnecting) {
      throw new Error('Session is currently reconnecting. Please wait...');
    }
    throw new Error('Echo is already active in this voice channel.');
  }

  // Create session
  const session = new VoiceSession({ voiceChannel, initiatedBy, voiceName });
  try {
    // Joins Discord vc, creates audio player, connects to Gemini, set up audio managers and event handlers
    await session.start();

    // Add session to map, after session.start() to ensure it's fully initialized
    sessions.set(voiceChannel.id, session);
    return session;
  } catch (error) { // Error handling
    await session.destroy('Setup failed.');
    throw error;
  }
}

// Ends a voice session in the given channel
async function endVoiceSession(channelId, reason = 'Session ended.') {
  const session = sessions.get(channelId);
  if (session) {
    await session.destroy(reason);
  }
}

// Gets the active voice session for a channel
function getVoiceSession(channelId) {
  return sessions.get(channelId) || null; // Returns null if no session exists
}

/* EXPORTS */
module.exports = {
  startVoiceSession,
  endVoiceSession,
  getVoiceSession,
};
