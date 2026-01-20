// voice/UserAudioReceiver.js
// Handles incoming user audio from Discord voice channels (Discord → Gemini)

/* IMPORTS */
const prism = require('prism-media'); // Opus decoder
const { EndBehaviorType } = require('@discordjs/voice'); // Discord voice stream control

// Debug logging flag from multiple environment variables
const DEBUG_VOICE = (() => {
    const raw = process.env.DEBUG_GEMINI ?? process.env.DEBUG_Echo ?? '';
    if (typeof raw === 'string') {
        return raw.toLowerCase() === 'true' || raw === '1';
    }
    return Boolean(raw);
})();

/* UserAudioReceiver CLASS */

/*
   Handles receiving and processing audio from Discord voice channel users

   Responsibilities:
   - Subscribes to Discord user audio streams
   - Decodes Opus → PCM audio
   - Implements silence detection (750ms timeout triggers "end of utterance")
   - Manages speaker switching (only one person at a time)
   - Forwards PCM audio to Gemini Live

   Lifecycle:
   1. User starts speaking → subscribe()
   2. Audio chunks arrive → handleChunk()
   3. 750ms silence → onSilence callback (signals end of utterance)
   4. User stops → stream cleanup

   Example:
   const receiver = new UserAudioReceiver({
     connection,
     onChunk: (pcm) => gemini.send(pcm),
     onSilence: () => gemini.endStream(),
   });
   receiver.start();
*/

class UserAudioReceiver {
    // Constructor
    // @param {Object} config
    // @param {import('@discordjs/voice').VoiceConnection} config.connection - Discord voice connection
    // @param {Function} config.onChunk - Callback when PCM audio arrives: (pcmBuffer) => void
    // @param {Function} config.onSpeakerChange - Callback when new speaker starts: (newUserId) => void
    // @param {Function} config.onSilence - Callback when 750ms silence detected: () => void
    // @param {string} config.botUserId - Bot's user ID (to ignore own audio)
    constructor({ connection, botUserId, onChunk, onSpeakerChange, onSilence }) {

        // Discord voice connection reference
        this.connection = connection;

        // Bot's user ID (to ignore own audio and prevent feedback loops)
        this.botUserId = botUserId;

        // Callbacks for audio events
        this.onChunk = onChunk; // Called when PCM chunk arrives
        this.onSpeakerChange = onSpeakerChange; // Called when speaker switches
        this.onSilence = onSilence; // Called when silence detected

        // Active audio subscriptions (userId → subscription object)
        this.subscriptions = new Map(); /** @type {Map<string, Object>} */

        // Currently speaking user ID (only one at a time)
        this.activeSpeaker = null; /** @type {string|null} */

        // Silence detection timer (triggers after 750ms of no audio)
        this.silenceTimer = null; /** @type {NodeJS.Timeout|null} */

        // Opus decoder error counter (for diagnostics)
        this.opusErrorCount = 0; /** @type {number} */
    }

    // Starts listening to all users in the voice channel
    // Registers Discord receiver event handlers for speaking start/end
    start() {

        // Get Discord voice receiver
        const receiver = this.connection.receiver;

        // Debounce tracking for subscriptions
        this.pendingSubscriptions = new Set();

        // Event: User starts speaking
        receiver.speaking.on('start', (userId) => {

            // Ignore bot's own audio
            if (this.botUserId && userId === this.botUserId) return;

            // Handle speaker active state (always update this)
            this.handleSpeakerStart(userId);

            // Logging (Debounced)
            if (!this.subscriptions.has(userId) && !this.pendingSubscriptions.has(userId)) {
                console.log('[UserAudioReceiver] Speaking start:', userId);
            }

            // Subscribe if needed (and not already pending)
            if (!this.subscriptions.has(userId) && !this.pendingSubscriptions.has(userId)) {

                this.pendingSubscriptions.add(userId);

                // Wait 150ms to ensure UDP stream is ready
                setTimeout(() => {
                    // Double check state
                    if (!this.subscriptions.has(userId)) {
                        this.subscribe(userId);

                        // Mark as speaking immediately
                        const payload = this.subscriptions.get(userId);
                        if (payload) payload.isSpeaking = true;
                    }
                    this.pendingSubscriptions.delete(userId);
                }, 150);
            } else {
                // Already subscribed, ensure flag is true
                const payload = this.subscriptions.get(userId);
                if (payload) {
                    payload.isSpeaking = true;
                }
            }
        });

        // Event: User stops speaking
        receiver.speaking.on('end', (userId) => {

            // Clear active speaker if this user was speaking
            if (this.activeSpeaker === userId) {
                this.activeSpeaker = null;
            }

            // Mark user as not speaking
            const payload = this.subscriptions.get(userId);
            if (payload) {
                payload.isSpeaking = false;
            }
        });
    }

    // Subscribes to a specific user's audio stream
    // Creates an Opus decoder and pipes audio to our chunk handler
    // @param {string} userId - Discord user ID
    subscribe(userId) {

        try {
            console.log('[UserAudioReceiver] Subscribing to user:', userId);

            // Subscribe to raw Opus stream from Discord
            const opusStream = this.connection.receiver.subscribe(userId, {
                end: {
                    behavior: EndBehaviorType.Manual, // Don't auto-close stream (we control lifecycle)
                },
            });

            // Create Opus decoder (Opus → PCM)
            const decoder = new prism.opus.Decoder({
                frameSize: 960,  // 20ms frames at 48kHz
                channels: 1,     // Mono (Discord sends mono per-user)
                rate: 48000,     // 48kHz sample rate
            });

            // Store stream metadata
            const payload = {
                opusStream,     // Raw Opus stream from Discord
                decoder,        // Opus decoder instance
                isSpeaking: false, // Is user currently speaking
                createdAt: Date.now(), // Timestamp for debugging
            };

            // Error handling for Opus stream errors
            opusStream.on('error', (error) => {
                console.error(`[UserAudioReceiver] Opus stream error for ${userId}:`, error);
                this.unsubscribe(userId); // Restart by unsubscribing
            });

            // Handle Opus decoding errors (usually Discord packet loss)
            decoder.on('error', (error) => {

                // Track error frequency for diagnostics
                this.opusErrorCount = (this.opusErrorCount || 0) + 1;

                // Only log every 10th error to reduce console spam
                // These errors are expected (network packet loss, Discord issues)
                if (DEBUG_VOICE && this.opusErrorCount % 10 === 1) {
                    console.warn(`[UserAudioReceiver] Opus decode errors: ${this.opusErrorCount} (Discord packet loss, expected)`);
                }

                // Restart decoder by unsubscribing (only way to recover from corrupted state)
                // UPDATE: Actually, don't kill the stream on packet loss. Just log and continue.
                // this.unsubscribe(userId);
            });

            // Stream end handlers to clean up when stream closes
            const handleStreamClosed = (reason) => {
                console.log(`[UserAudioReceiver] Stream ${reason} for ${userId}`);
                this.unsubscribe(userId); // Clean up resources
            };
            opusStream.on('end', () => handleStreamClosed('ended'));
            opusStream.on('close', () => handleStreamClosed('closed'));

            // Pipe Opus stream → Decoder to convert Opus → PCM
            opusStream.on('data', (chunk) => {
                // Diagnose if we are receiving raw opus but decoder is stuck
                if (DEBUG_VOICE && Math.random() < 0.05) { // 5% sample to avoid spam
                    console.log(`[UserAudioReceiver] Rx Opus packet: ${chunk.length} bytes`);
                }
            });
            opusStream.pipe(decoder);

            // Handle decoded PCM audio chunks
            decoder.on('data', (pcmChunk) => {
                console.log('[UserAudioReceiver] PCM bytes:', pcmChunk.length);

                // Only process if user is marked as speaking
                if (payload.isSpeaking) {
                    this.handleChunk(userId, pcmChunk);
                }
            });

            // Store subscription in map
            this.subscriptions.set(userId, payload);

        } catch (error) {
            console.error(`[UserAudioReceiver] Failed to subscribe to ${userId}:`, error);
        }
    }

    // Unsubscribes from a user's audio stream and cleans up resources
    // @param {string} userId - Discord user ID
    unsubscribe(userId) {

        // Get subscription payload
        const payload = this.subscriptions.get(userId);
        if (!payload) return; // Already unsubscribed

        console.log('[UserAudioReceiver] Unsubscribing from user:', userId);

        // Clean up Opus stream
        try {
            if (payload.opusStream) {
                payload.opusStream.removeAllListeners(); // Remove listeners to prevent memory leaks
                payload.opusStream.unpipe(); // Disconnect pipe
                if (!payload.opusStream.destroyed) {
                    payload.opusStream.destroy(); // Destroy stream
                }
            }
        } catch (error) {
            console.error(`[UserAudioReceiver] Error cleaning up Opus stream for ${userId}:`, error);
        }

        // Clean up decoder
        try {
            if (payload.decoder) {
                payload.decoder.removeAllListeners(); // Remove listeners
                if (!payload.decoder.destroyed) {
                    payload.decoder.destroy(); // Destroy decoder
                }
            }
        } catch (error) {
            console.error(`[UserAudioReceiver] Error cleaning up decoder for ${userId}:`, error);
        }

        // Remove from map
        this.subscriptions.delete(userId);
    }

    // Handles a PCM audio chunk from a user
    // Only processes audio from active speaker (ignores others)
    // Forwards PCM to Gemini via onChunk callback
    // Resets silence timer (750ms countdown to "end of utterance")
    // @param {string} userId - Discord user ID
    // @param {Buffer} pcmBuffer - Decoded PCM audio (48kHz mono)
    handleChunk(userId, pcmBuffer) {

        // Ignore if this user is not the active speaker
        if (this.activeSpeaker !== userId) {
            return;
        }

        // Forward to Gemini (callback to voiceSessionManager)
        this.onChunk(pcmBuffer);

        // Reset silence detection timer (user is still speaking)
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }

        // Start new 750ms countdown
        // If no audio arrives within 750ms, assume user finished speaking
        this.silenceTimer = setTimeout(() => {
            console.log('[UserAudioReceiver] Silence detected (750ms)');
            this.onSilence(); // Trigger end of utterance callback
        }, 750);
    }

    // Handles a new user starting to speak
    // Manages speaker switching logic:
    // - If someone is already speaking, signal end of their utterance
    // - Switch active speaker to new person
    // - Notify via onSpeakerChange callback
    // @param {string} userId - Discord user ID of new speaker
    handleSpeakerStart(userId) {

        // If someone else was speaking, interrupt them
        if (this.activeSpeaker && this.activeSpeaker !== userId) {
            console.log(`[UserAudioReceiver] Speaker switch: ${this.activeSpeaker} → ${userId}`);
            this.onSpeakerChange(userId); // Notify session manager to interrupt Gemini
        }

        // Set new active speaker
        this.activeSpeaker = userId;
    }

    // Cleanup on session destroy
    // Unsubscribes from all users and clears timers
    destroy() {

        console.log('[UserAudioReceiver] Destroying (cleanup)');

        // Unsubscribe from all users to clean up streams and decoders
        for (const [userId] of this.subscriptions) {
            this.unsubscribe(userId);
        }

        // Clear silence timer to prevent late callbacks
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }
}

// Exports
module.exports = { UserAudioReceiver };
