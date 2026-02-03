// core/scheduler.js
// Wakes up every minute (low cost), checks DB for new messages and decides whether to trigger analysis

const { pool } = require('../db');
const { analyzeGuild } = require('./analyzer');
const { getGuildSettings } = require('./guild-settings');

// Basic configuration
const CHECK_INTERVAL_MS = 60 * 1000; // Check every 1 minute

// Track which guilds are currently being analyzed to prevent overlap
const guildLocks = new Map();

// Starts the polling loop
function startScheduler() {
    console.log('[Scheduler] Pulse started. Checking every 1m...');

    // Initial immediate check
    checkAllGuilds();

    // Schedule periodic checks
    setInterval(checkAllGuilds, CHECK_INTERVAL_MS);
}

// Check all known guilds concurrently
/**
 * @returns {Promise<void>}
 */
async function checkAllGuilds() {
    try {
        // Get all unique cursor entries to know which guilds we are tracking
        /** @type {any[]} */
        const [cursors] = await pool.query('SELECT guild_id, last_message_id, updated_at FROM analysis_cursor');

        // If no guilds found, do nothing
        if (!cursors.length) {
            console.log('[Scheduler] No active guilds found.');
            return;
        }

        // Run all guild checks in parallel
        await Promise.all(
            // @ts-ignore
            cursors.map(row =>
                checkGuild(row.guild_id, row.last_message_id, new Date(row.updated_at))
            )
        );

    } catch (err) { // Error handling
        console.error('[Scheduler] Error in heartbeat:', err);
    }
}

// Decides if a specific guild needs analysis
/**
 * @param {string} guildId
 * @param {number} lastMsgId
 * @param {Date} lastRunTime
 */
async function checkGuild(guildId, lastMsgId, lastRunTime) {

    // Check Lock
    // If locked, it means we are either checking OR analyzing this guild already. Skip.
    if (guildLocks.has(guildId)) {
        return;
    }

    // Acquire lock immediately to prevent other checks from racing us
    guildLocks.set(guildId, true);

    try {
        const settings = await getGuildSettings(guildId);

        // If background analysis is disabled for this guild, skip quietly
        if (!settings.backgroundAnalysis) {
            return;
        }

        // 1. Get Dynamic Thresholds (Updated by Analyzer)
        /** @type {any[]} */
        const [meta] = await pool.query(
            'SELECT target_threshold, msg_rate_avg FROM analysis_cursor WHERE guild_id = ?',
            [guildId]
        );

        // Defaults if first run
        const targetThreshold = (meta && meta[0]?.target_threshold) || 20;
        const avgRate = (meta && meta[0]?.msg_rate_avg) || 1.0;

        // Count NEW messages since last analysis
        /** @type {any[]} */
        const [rows] = await pool.query(
            'SELECT COUNT(*) as count FROM messages WHERE guild_id = ? AND id > ?',
            [guildId, lastMsgId]
        );
        const newCount = rows[0].count;

        if (newCount === 0) return;

        // Calculate Pending Rate (Spike Detection) - Restore this calculation
        const timeDiffMins = Math.max(0.1, (Date.now() - lastRunTime.getTime()) / 60000);
        const pendingRate = newCount / timeDiffMins;

        // Critical safety check (immediate trigger)
        // Check if any new pending messages contain urgent safety keywords
        /** @type {any[]} */
        const [safetyRows] = await pool.query(
            `SELECT COUNT(*) as count FROM messages 
             WHERE guild_id = ? AND id > ? 
             AND (
               content LIKE '%stalk%' OR 
               content LIKE '%suicid%' OR 
               content LIKE '%self-harm%' OR 
               content LIKE '%kill%' OR 
               content LIKE '%die%' OR 
               content LIKE '%harassment%' OR
               content LIKE '%自杀%' OR
               content LIKE '%跟踪%' OR
               content LIKE '%想死%' OR
               content LIKE '%不想活%' OR
               content LIKE '%骚扰%'
             )`,
            [guildId, lastMsgId]
        );
        const safetyCount = safetyRows[0].count;

        let shouldTrigger = false;
        let reason = '';

        if (safetyCount > 0) {
            shouldTrigger = true;
            reason = `URGENT: Safety Keyword Detected`;
        }
        // Condition A: Batch Full (Dynamic Threshold)
        else if (newCount >= targetThreshold) {
            shouldTrigger = true;
            reason = `Batch Full (${newCount}/${targetThreshold})`;
        }
        // Condition B: Rate Spike (2x Average)
        else if (pendingRate > (avgRate * 2.0) && newCount >= 5) {
            shouldTrigger = true;
            reason = `Spike Detected (Rate ${pendingRate.toFixed(1)} > ${avgRate.toFixed(1)}*2)`;
        }

        // Trigger Analysis
        if (shouldTrigger) {
            console.log(`[Scheduler] Triggering Analysis for ${guildId}: ${reason}`);

            try {
                // Analysis happens WHILE we hold the lock (so next minute's check will skip)
                await analyzeGuild(guildId);
                console.log(`[Scheduler] Analysis finished for ${guildId}`);
            } catch (err) {
                console.error(`[Scheduler] Job failed for ${guildId}:`, err);
            }
        }

    } catch (err) {
        console.error(`[Scheduler] Check failed for ${guildId}:`, err);
    } finally {
        // Release lock
        guildLocks.delete(guildId);
    }
}

// Allow external triggers (e.g. from observer.js) to request immediate check
// This enables real-time responsiveness without waiting for the 1-minute pulse
/**
 * @param {string} guildId
 * @returns {Promise<void>}
 */
function triggerCheck(guildId) {
    return checkSingleGuild(guildId);
}

// Queue to track urgent requests if locked
const urgentQueue = new Set();

/**
 * @param {string} guildId
 */
async function checkSingleGuild(guildId) {
    // Check a single guild immediately (bypassing the loop wait, but still respecting locks inside checkGuild)

    try {
        /** @type {any[]} */
        const [rows] = await pool.query('SELECT guild_id, last_message_id, updated_at FROM analysis_cursor WHERE guild_id = ?', [guildId]);
        if (rows.length > 0) {
            const row = rows[0];
            await checkGuild(row.guild_id, row.last_message_id, new Date(row.updated_at));
        } else {
            // First time analysis?
            await checkGuild(guildId, 0, new Date(0));
        }
    } catch (err) {
        console.error(`[Scheduler] Single check failed for ${guildId}:`, err);
    }
}

module.exports = {
    startScheduler,
    triggerCheck
};
