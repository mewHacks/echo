// voice/AudioStreamManager.js
// Converts Gemini's streamed audio responses into clean, non-duplicated, correctly-timed Discord voice output

/* IMPORTS */
const { createAudioResource, StreamType } = require('@discordjs/voice'); // Discord voice primitives
const { PassThrough } = require('node:stream'); // Node.js stream for audio buffering
const { writeChunkToPlayback } = require('./utils'); // Audio format conversion utilities
const crypto = require('crypto'); // MD5 hashing for duplicate detection

/* AudioStreamManager CLASS */

/*
   Handles the lifecycle of audio playback streams from Gemini to Discord

   Key responsibilities:
   - Creates a new PassThrough stream for each Gemini response ("turn")
   - Writes audio chunks to the active stream
   - Detects and skips duplicate audio (prevents double-playback)
   - Closes streams when Gemini signals turnComplete

   Lifecycle:
   1. First audio chunk arrives → createStream()
   2. Subsequent chunks → writeChunk()
   3. turnComplete signal → closeStream()
   4. Repeat for next response

   Example:
   const manager = new AudioStreamManager(audioPlayer);
   await manager.writeChunk(buffer, 'audio/pcm;rate=24000'); // Auto-creates stream
   manager.closeStream(); // End of response
*/

class AudioStreamManager {

    // Constructor
    // @param {import('@discordjs/voice').AudioPlayer} audioPlayer - Discord.js audio player
    constructor(audioPlayer) {

        // Discord audio player reference
        this.audioPlayer = audioPlayer;

        // Current active playback stream
        this.currentStream = null; /** @type {PassThrough|null} */

        // Recent audio chunk hashes for de-duplication (stores last 10 hashes to detect identical repeats)
        this.recentAudioHashes = []; /** @type {string[]} */

        // Adaptive backpressure management
        this.latencyHistory = []; /** @type {number[]} - Recent write latencies (milliseconds) */
        this.maxLatencyHistory = 20; /** @type {number} - Maximum latency history size */
        this.latencyThreshold = 50; /** @type {number} - Threshold for "bad" latency (ms) */
        this.backpressureEnabled = false; /** @type {boolean} - Is backpressure currently enabled? */
    }

    // Creates a new playback stream for the current Gemini response
    // Should be called once per "turn" (when first audio chunk arrives)
    // The stream is connected to Discord's audio player via createAudioResource
    // @returns {PassThrough} - The newly created stream
    createStream() {

        // Safety check to warn if stream already exists (shouldn't happen, but handle gracefully)
        if (this.currentStream && !this.currentStream.destroyed) {
            console.warn('[AudioStreamManager] Stream already exists! Force-closing old stream.');
            this.closeStream(); // Clean up old stream before creating new one
        }

        // Create new PassThrough stream to buffer audio chunks
        this.currentStream = new PassThrough();

        // Connect stream to Discord audio player
        const resource = createAudioResource(this.currentStream, {
            inputType: StreamType.Raw, // Raw PCM audio (no Opus encoding needed)
        });
        this.audioPlayer.play(resource); // Start playback immediately

        console.log('[AudioStreamManager] Created new playback stream');
        return this.currentStream;
    }

    // Writes an audio chunk to the active stream
    // Features:
    // - De-duplication via MD5 hashing
    // - Adaptive backpressure (automatically enabled when latency is high)
    // - Format conversion (PCM or transcoded)
    // @param {Buffer} buffer - PCM audio data
    // @param {string} mimeType - Audio format (e.g., 'audio/pcm;rate=24000')
    // @returns {Promise<boolean>} - True if chunk was written, false if duplicate
    async writeChunk(buffer, mimeType) {

        // Track write latency for adaptive backpressure
        const startTime = Date.now();

        // Auto-create stream if doesn't exist or was destroyed
        if (!this.currentStream || this.currentStream.destroyed) {
            this.createStream();
        }

        // De-duplication: hash first 1KB of audio to detect duplicates
        // (Full buffer hashing is too CPU-intensive for real-time audio)
        const sampleSize = Math.min(1024, buffer.length);
        const hash = crypto
            .createHash('md5')
            .update(buffer.slice(0, sampleSize))
            .digest('hex');

        // Check if we've seen this audio recently (Gemini sometimes sends duplicates)
        if (this.recentAudioHashes.includes(hash)) {
            console.warn('[AudioStreamManager] Skipping duplicate audio chunk (hash collision)');
            return false; // Skip duplicate audio to prevent double-playback
        }

        // Store hash for future comparisons
        this.recentAudioHashes.push(hash);

        // Keep only last 10 hashes (space optimization)
        if (this.recentAudioHashes.length > 10) {
            this.recentAudioHashes.shift();
        }

        // Adaptive backpressure: Check if stream is congested (write buffer > 32KB)
        if (this.backpressureEnabled && this.currentStream.writableLength > 32768) {
            console.log('[AudioStreamManager] Backpressure active, waiting for drain...');

            // Wait for buffer to drain before writing more data
            await new Promise((resolve) => {
                this.currentStream.once('drain', resolve); // Resolves when buffer is empty
                setTimeout(resolve, 500); // Timeout after 500ms to prevent deadlock
            });
        }

        // Write to stream (handles format conversion if needed)
        try {
            // Delegate to utils.js for format conversion (PCM resampling or FFmpeg transcoding)
            await writeChunkToPlayback(this.currentStream, { buffer, mimeType });

            // Track write latency for adaptive backpressure
            const latency = Date.now() - startTime;
            this.updateLatencyMetrics(latency);

            // Write successful
            return true;
        } catch (error) { // Error handling
            console.error('[AudioStreamManager] Error writing chunk:', error);
            // Write failed
            return false;
        }
    }

    // Updates latency metrics and adaptively enables/disables backpressure
    // Logic:
    // - If average latency > 50ms → Enable backpressure (prioritize smoothness)
    // - If average latency < 20ms → Disable backpressure (prioritize low latency)
    // @param {number} latency - Write latency in milliseconds
    updateLatencyMetrics(latency) {

        // Add latest latency to history
        this.latencyHistory.push(latency);

        // Keep only last 20 latency measurements
        if (this.latencyHistory.length > this.maxLatencyHistory) {
            this.latencyHistory.shift();
        }

        // Calculate average latency over recent writes
        const avgLatency = this.latencyHistory.reduce((a, b) => a + b, 0) / this.latencyHistory.length;

        // Adaptive backpressure decision based on average latency
        const wasEnabled = this.backpressureEnabled;

        // High latency → Enable backpressure (smooth audio, prevent buffer overflow)
        if (avgLatency > this.latencyThreshold) {
            this.backpressureEnabled = true;

            // Log only when state changes to reduce console spam
            if (!wasEnabled) {
                console.log(`[AudioStreamManager] Adaptive backpressure ENABLED (avg latency: ${avgLatency.toFixed(1)}ms)`);
            }

            // Low latency → Disable backpressure (low latency, prioritize speed)
        } else if (avgLatency < 20) {
            this.backpressureEnabled = false;

            // Log only when state changes
            if (wasEnabled) {
                console.log(`[AudioStreamManager] Adaptive backpressure DISABLED (avg latency: ${avgLatency.toFixed(1)}ms)`);
            }
        }

        // Middle range (20-50ms): Keep current state (hysteresis to prevent thrashing)
    }

    // Closes the current stream (called when Gemini signals turnComplete)
    // Cleanup steps:
    // 1. Clear reference FIRST (prevents re-entry)
    // 2. Remove all event listeners (prevent memory leaks)
    // 3. Destroy stream immediately (real-time audio, no flush needed)
    closeStream() {

        // Early return if no stream exists
        if (!this.currentStream) {
            return;
        }

        // Store reference and clear FIRST to prevent re-entry
        const stream = this.currentStream;
        this.currentStream = null;

        try {
            // Remove all listeners to prevent memory leaks
            stream.removeAllListeners();

            // For real-time audio, destroy immediately (no waiting for flush)
            stream.destroy();

            console.log('[AudioStreamManager] Closed playback stream');
        } catch (error) {
            console.error('[AudioStreamManager] Error closing stream:', error);
        }
    }

    // Emergency stop - immediately stops audio playback
    // Used when:
    // - Gemini interrupts itself (content.interrupted = true)
    // - User forces bot to stop
    // - Session is being destroyed
    flush() {

        console.log('[AudioStreamManager] Flushing audio (emergency stop)');

        // Close current stream
        this.closeStream();

        // Stop Discord audio player to stop all output
        try {
            this.audioPlayer.stop(true); // true = force stop
        } catch (error) {
            console.error('[AudioStreamManager] Error stopping player:', error);
        }
    }

    // Cleanup on session destroy to prevent resources leakage
    destroy() {

        // Close any active stream
        this.closeStream();

        // Clear hash history for garbage collection
        this.recentAudioHashes = [];
    }
}

// Exports
module.exports = { AudioStreamManager };
