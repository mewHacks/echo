// filepath: utils/debugging.js
// Utilities for debugging and timing

const { performance } = require('node:perf_hooks');

/**
 * @typedef {Object} TimingEntry
 * @property {string} label - Timer label
 * @property {number} duration - Duration in milliseconds
 */

const DEBUG_GEMINI = (() => {
  const raw = process.env.DEBUG_GEMINI ?? process.env.DEBUG_Echo ?? '';
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }
  return Boolean(raw);
})();

/**
 * Log debug messages when DEBUG_GEMINI is enabled
 * @param {...any} args - Arguments to log
 */
const debugLog = (...args) => {
  if (!DEBUG_GEMINI) return;
  console.log('[Gemini DEBUG]', ...args);
};

/**
 * Create a timer function for performance measurement
 * @param {string} label - Timer label
 * @param {TimingEntry[]} timings - Timings array to push to
 * @returns {function(): number} Function that stops the timer and returns duration
 */
const startTimer = (label, timings) => {
  if (!DEBUG_GEMINI) {
    return () => 0;
  }
  const startedAt = performance.now();
  return () => {
    const duration = performance.now() - startedAt;
    timings.push({ label, duration });
    debugLog(`${label} took ${duration.toFixed(2)} ms`);
    return duration;
  };
};

/**
 * Log performance timing summary
 * @param {TimingEntry[]} timings - Array of timing objects
 * @param {number} totalDuration - Total duration
 */
function logTimingSummary(timings, totalDuration) {
  if (!DEBUG_GEMINI) return;
  
  const sorted = [...timings].sort((a, b) => b.duration - a.duration);
  debugLog('--- Gemini timing summary (ms) ---');
  for (const entry of sorted) {
    debugLog(`- ${entry.label}: ${entry.duration.toFixed(2)} ms`);
  }
  debugLog(`Gemini run complete in ${totalDuration.toFixed(2)} ms\n\n\n`);
}

module.exports = {
  DEBUG_GEMINI,
  debugLog,
  startTimer,
  logTimingSummary,
};
