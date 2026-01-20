// voice/utils.js
// Shared audio processing utilities for voice session management
// Converts and normalizes audio from Gemini into Discord required format (Very strict)
// Prevents accidentally sending 24kHz, wav, mp3, etc. to Discord

/*
   Responsibilities:
   -Sample rates
   -Channel counts
   -PCM format correctness
   -FFmpeg transcoding
   -Security (command injection prevention)
*/

const prism = require('prism-media');
const { Readable } = require('node:stream');

/**
 * Extracts a numeric parameter from a MIME type string
 * Example: extractNumber('audio/pcm;rate=48000', 'rate') → 48000
 * 
 * @param {string} source - MIME type string
 * @param {string} key - Parameter name to extract
 * @returns {number|null} - Extracted number or null if not found
 */
function extractNumber(source, key) {
    const match = source.match(new RegExp(`${key}=(\\d+)`));
    if (!match) return null; // Handle missing MIME type params
    return Number(match[1]); // Return numeric value
}

/**
 * Converts PCM audio to Discord-compatible format (48kHz stereo)
 * 
 * Discord voice requires:
 * - Sample rate: 48000 Hz
 * - Channels: 2 (stereo)
 * - Format: Signed 16-bit PCM
 * 
 * @param {Buffer} buffer - Input PCM buffer
 * @param {number} sampleRate - Input sample rate (e.g., 24000)
 * @param {number} channels - Input channel count (e.g., 1 for mono)
 * @returns {Buffer} - Converted 48kHz stereo PCM buffer
 */
function ensurePcm48kStereo(buffer, sampleRate, channels) {

    // Initialize working buffer (progressively transformed through stages)
    let working = buffer;

    // Convert to mono (Discord expects stereo, but we build from mono because cheaper)
    if (channels !== 1) {
        working = downmixToMono(working, channels);
    }

    // Resample to 48kHz
    if (sampleRate !== 48000) {
        working = resampleMonoPcm(working, sampleRate, 48000);
    }

    // Duplicate mono to stereo (Discord requirement)
    return duplicateMonoToStereo(working);
}

/**
 * Downmixes multi-channel audio to mono by averaging all channels
 * 
 * @param {Buffer} buffer - Multi-channel PCM buffer
 * @param {number} channels - Number of input channels
 * @returns {Buffer} - Mono PCM buffer
 */
function downmixToMono(buffer, channels) {

    // If already mono, return as it is
    if (channels <= 1) return buffer;

    // Calculate sample count and allocate mono buffer (samples * 2 bytes)
    const sampleCount = buffer.length / 2 / channels;
    const mono = Buffer.alloc(sampleCount * 2);

    // Iterate over samples
    for (let i = 0; i < sampleCount; i++) {
        let sum = 0;

        // Read the same sample index across all channels, converts stereo/surround → mono
        // Uses averaging (standard technique) to perserve perceived loudness and prevent clippings
        for (let ch = 0; ch < channels; ch++) {
            const offset = (i * channels + ch) * 2;
            sum += buffer.readInt16LE(offset);
        }
        // Writes the averaged value as mono PCM
        const avg = Math.round(sum / channels);
        mono.writeInt16LE(avg, i * 2);
    }

    return mono;
}

/**
 * Resamples mono PCM audio to a different sample rate using linear interpolation
 * Changes time resolution of audio
 * 
 * @param {Buffer} buffer - Input mono PCM buffer
 * @param {number} fromRate - Input sample rate
 * @param {number} toRate - Output sample rate
 * @returns {Buffer} - Resampled mono PCM buffer
 */
function resampleMonoPcm(buffer, fromRate, toRate) {

    // If same rate or invalid, return as it is
    if (fromRate === toRate || fromRate <= 0) {
        return Buffer.from(buffer);
    }

    // Calculates ratio (e.g., 24kHz → 48kHz → ratio = 2.0)
    const ratio = toRate / fromRate;

    // Calculates how many output samples are needed
    const inputSamples = buffer.length / 2;
    const outputSamples = Math.max(1, Math.round(inputSamples * ratio));

    // Allocates target PCM buffer
    const output = Buffer.alloc(outputSamples * 2);

    // Linear interpolation loop between samples
    for (let i = 0; i < outputSamples; i++) {

        // Maps output time → input time
        const origin = i / ratio;
        const leftIndex = Math.floor(origin);
        const rightIndex = Math.min(leftIndex + 1, inputSamples - 1);
        const interp = origin - leftIndex;

        const leftSample = buffer.readInt16LE(leftIndex * 2);
        const rightSample = buffer.readInt16LE(rightIndex * 2);

        // Linear interpolation between nearest input samples
        // Cheap, fast and good enough for voice with low bandwidth
        const value = Math.round(leftSample * (1 - interp) + rightSample * interp);

        output.writeInt16LE(value, i * 2);
    }

    return output;
}

/**
 * Duplicates a mono PCM buffer to stereo by copying each sample to both channels
 * Keeps sound centered, no phase issue and satisfy Discord's requirement
 * 
 * @param {Buffer} buffer - Mono PCM buffer
 * @returns {Buffer} - Stereo PCM buffer (2x size)
 */
function duplicateMonoToStereo(buffer) {

    // Calculate sample count and allocate stereo buffer
    // Stereo = 2 channels × 2 bytes × samples
    const sampleCount = buffer.length / 2;
    const stereo = Buffer.alloc(sampleCount * 4);

    // Duplicate each mono sample to both channels
    for (let i = 0; i < sampleCount; i++) {
        const value = buffer.readInt16LE(i * 2);
        const offset = i * 4;
        stereo.writeInt16LE(value, offset);     // Left channel
        stereo.writeInt16LE(value, offset + 2); // Right channel
    }

    return stereo;
}

/**
 * Sanitizes a MIME type string to prevent command injection (for security purposes)
 * Only allows safe characters: letters, numbers, /, ;, =, -, and .
 * 
 * @param {string} mimeType - Input MIME type
 * @returns {string} - Sanitized MIME type
 */
function sanitizeMimeType(mimeType) {

    // If invalid, return empty string
    if (!mimeType || typeof mimeType !== 'string') {
        return '';
    }

    // Allows letters, numbers, /, ;, =, -, and .
    // Removes $, `, (, ), |, &, ;(shell separator), whitespace etc.
    return mimeType.replace(/[^a-zA-Z0-9/;=.\-]/g, '');
}

/**
 * Builds FFmpeg arguments for transcoding audio to Discord-compatible format.
 * 
 * @param {string} mimeType - Input MIME type (e.g., 'audio/wav')
 * @returns {string[]} - FFmpeg command arguments
 */
function buildFfmpegArgs(mimeType = '') {

    // Sanitize MIME type to prevent command injection
    const safeMimeType = sanitizeMimeType(mimeType);
    const lower = safeMimeType.toLowerCase();

    // Optimize FFmpeg arguments by disabling FFmpeg probing delays and silent logs
    const args = ['-analyzeduration', '0', '-loglevel', '0'];

    // Input format detection
    // PCM requires manually specified format, sample rate and channels
    if (lower.startsWith('audio/pcm')) {
        const rate = extractNumber(lower, 'rate') || 24000;
        const channels = extractNumber(lower, 'channels') || 1;

        // Tells FFmpeg how to interpret raw bytes
        args.push('-f', 's16le', '-ar', `${rate}`, '-ac', `${channels}`);

    } else if (lower.startsWith('audio/wav')) {
        args.push('-f', 'wav');
    } else if (lower.startsWith('audio/mp3')) {
        args.push('-f', 'mp3');
    } else if (lower.startsWith('audio/ogg')) {
        args.push('-f', 'ogg');
    }

    // Output format for Discord requirement
    // Read from stdin, output Stereo PCM at 48kHz, output raw PCM to stdout
    args.push('-i', 'pipe:0', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:1');
    return args;
}

/**
 * Transcodes an audio chunk to Discord-compatible PCM and writes to a stream.
 * Uses FFmpeg for non-PCM formats (WAV, MP3, OGG, etc.)
 * This is the slow path
 * 
 * @param {Object} chunk - Audio chunk
 * @param {Buffer} chunk.buffer - Raw audio data
 * @param {string} chunk.mimeType - Audio format
 * @param {Stream} destinationStream - Output stream
 * @returns {Promise<void>}
 */
function transcodeChunkToStream(chunk, destinationStream) {

    // If destination stream is invalid, resolve immediately to avoid writing into dead streams
    if (!destinationStream || destinationStream.destroyed) {
        return Promise.resolve();
    }

    // Transcode chunk to Discord-compatible PCM and write to destination stream
    return new Promise((resolve, reject) => {

        // Build FFmpeg arguments for transcoding
        const args = buildFfmpegArgs(chunk.mimeType);

        // Creates FFmpeg subprocess safely (no shell)
        const transcoder = new prism.FFmpeg({ args });

        // Wraps buffer in a stream so FFmpeg can read it
        const input = Readable.from([chunk.buffer]);

        // Cleanup function to prevent dangling listeners, memory leaks and hanging pipes
        const cleanup = (error) => {
            transcoder.removeAllListeners();
            input.removeAllListeners();
            try {
                transcoder.unpipe(destinationStream);
            } catch (unpipeError) {
                // Ignore unpipe errors
            }
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        // Attach error handlers
        transcoder.once('error', cleanup);
        transcoder.once('close', () => cleanup());
        input.once('error', cleanup);

        // Pipe the input stream to the transcoder, then to the destination stream
        // Data flow: buffer → Readable → FFmpeg → Discord stream
        transcoder.pipe(destinationStream, { end: false });
        input.pipe(transcoder);
    });
}

/**
 * Writes an audio chunk to a playback stream, handling format conversion
 * This is the fast path that acts the entry point for AudioStreamManager
 * 
 * @param {Stream} playbackStream - PassThrough stream connected to Discord audio player
 * @param {Object} chunk - Audio chunk
 * @param {Buffer} chunk.buffer - Raw audio data
 * @param {string} chunk.mimeType - Audio format (e.g., 'audio/pcm;rate=24000')
 * @returns {Promise<void>}
 */
async function writeChunkToPlayback(playbackStream, chunk) {
    const lower = (chunk.mimeType || '').toLowerCase();

    // Fast path: PCM audio (no FFmpeg transcoding needed, just resampling)
    if (lower.startsWith('audio/pcm')) {
        const sampleRate = extractNumber(lower, 'rate') || 24000;
        const channels = extractNumber(lower, 'channels') || 1;

        // Write directly for minimal latency
        const pcmBuffer = ensurePcm48kStereo(chunk.buffer, sampleRate, channels);
        playbackStream.write(pcmBuffer);
        return;
    }

    // Slow path when no choice: Other formats (WAV, MP3, OGG) - use FFmpeg
    await transcodeChunkToStream(chunk, playbackStream);
}

// Exports
module.exports = {
    sanitizeMimeType,
    extractNumber,
    ensurePcm48kStereo,
    downmixToMono,
    resampleMonoPcm,
    duplicateMonoToStereo,
    buildFfmpegArgs,
    transcodeChunkToStream,
    writeChunkToPlayback,
};
