// core/analyzer.js
// Analyzes batches of messages to extract insights, topics and sentiment

const { getGeminiClient } = require('../gemini-client');
const { pool } = require('../db');
const { debugLog } = require('../utils/debugging');
const { GEMINI_ANALYZER_MODEL } = require('../config/models'); // Configure model

// Configure system prompt
const SYSTEM_PROMPT = `
You are a Community Intelligence Analyzer. 
You will receive a batch of Discord chat messages.
Your job is to extract OBJECTIVE data about the conversation.

Output STRICT JSON with this schema:
{   
  "topics": [
    { "topic": "string (lowercase keyword)", "weight": "number (0.1 to 1.0)" }
  ],
  "sentiment": {
    "avg": "number (-1.0 to 1.0)",
    "min": "number (-1.0 to 1.0)",
    "negative_ratio": "number (0.0 to 1.0)"
  },
  "events": [
    { "type": "string (e.g. CONFLICT, HELP_REQUEST, SPAM)", "desc": "string summary", "confidence": "number (0.0 to 1.0)" }
  ]
}

Rules:
- "sentiment.min": The score of the MOST negative message in the batch.
- "sentiment.negative_ratio": The fraction of messages that are negative (< -0.2).
- "topics": Identify up to 5 key topics. Group similar concepts (e.g., "coding", "java", "error" -> "java error").
- "events":
  - Flag "CONFLICT" for arguments/fights.
  - Flag "HELP_REQUEST" for persistent questions.
  - Flag "SAFETY_RISK" for stalking, harassment, suicide, or self-harm keywords (CRITICAL).
  - Otherwise leave empty.
`.trim();

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * @typedef {Object} Topic
 * @property {string} topic - The topic name
 * @property {number} weight - Relevance weight (0.1 to 1.0)
 */

/**
 * @typedef {Object} Sentiment
 * @property {number} avg - Average sentiment (-1.0 to 1.0)
 * @property {number} min - Minimum sentiment detected (-1.0 to 1.0)
 * @property {number} negative_ratio - Ratio of negative messages (0.0 to 1.0)
 */

/**
 * @typedef {Object} AnalyzerEvent
 * @property {string} type - Event type (CONFLICT, HELP_REQUEST, etc.)
 * @property {string} desc - Event description
 * @property {number} confidence - Confidence score (0.0 to 1.0)
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {Topic[]} topics - Extracted topics
 * @property {Sentiment} sentiment - Sentiment analysis
 * @property {AnalyzerEvent[]} events - Detected events
 */

/**
 * Database row shape for messages table
 * @typedef {Object} MessageRow
 * @property {number} id
 * @property {string} guild_id
 * @property {string} channel_id
 * @property {string} channel_name
 * @property {string} user_id
 * @property {string} username
 * @property {string} content
 * @property {Date} created_at
 */

/**
 * Process one guild's messages only
 * Checks DB for new messages, fetches context (overlap), runs Gemini Analysis and updates cursor & stats
 *
 * @param {string} guildId - Discord guild ID
 * @returns {Promise<AnalysisResult|null|undefined>} - Analysis result or null if no new messages
 */
async function analyzeGuild(guildId) {

    // Get a dedicated db connection for safety
    const conn = await pool.getConnection();

    try {
        // Fetch analysis cursor to know where we last stopped (last message + metrics)
        /** @type {any[]} */
        const [cursors] = await conn.query(
            'SELECT last_message_id, msg_rate_avg, updated_at FROM analysis_cursor WHERE guild_id = ?',
            [guildId]
        );

        // Fallback defaults if first run
        const lastId = cursors[0]?.last_message_id || 0;
        const oldRateAvg = cursors[0]?.msg_rate_avg || 1.0;
        const lastRunTime = cursors[0]?.updated_at ? new Date(cursors[0].updated_at).getTime() : Date.now() - 60000;

        // Fetch new messages (Limit 100 to prevent overflow)
        /** @type {any[]} */
        const [newMessages] = await conn.query(
            'SELECT * FROM messages WHERE guild_id = ? AND id > ? ORDER BY id ASC LIMIT 100',
            [guildId, lastId]
        );

        // If no new messages, nothing to analyze
        if (newMessages.length === 0) {
            debugLog(`[Analyzer] No new messages for ${guildId}`);
            return null;
        }

        console.log(`[Analyzer] Pulled ${newMessages.length} new messages for Guild ${guildId}`);

        // Fetch context overlap
        // Need to have previous 20 messages to understand the start of this batch
        /** @type {any[]} */
        const [contextMessages] = await conn.query(
            'SELECT username, content, channel_name FROM messages WHERE guild_id = ? AND id <= ? ORDER BY id DESC LIMIT 20',
            [guildId, lastId]
        );
        // Reverse them back to chronological order (oldest to newest)
        contextMessages.reverse();

        // Construct transcript that includes both context (marked as History) and new data
        const contextText = contextMessages.map((/** @type {MessageRow} */ m) => `[HISTORY] [#${m.channel_name}] [${m.username}]: ${m.content}`).join('\n');
        const newText = newMessages.map((/** @type {MessageRow} */ m) => `[#${m.channel_name}] [${m.username}]: ${m.content}`).join('\n');

        const fullPrompt = `
PREVIOUS CONTEXT (For understanding only, do not analyze stats for these):
${contextText}

CURRENT BATCH (Analyze these stats):
${newText}
        `.trim();

        // Call Gemini
        const start = Date.now();
        const ai = getGeminiClient();

        const result = await ai.models.generateContent({
            model: GEMINI_ANALYZER_MODEL,
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            config: {
                systemInstruction: SYSTEM_PROMPT,
                responseMimeType: 'application/json',
            },
        });

        // Hold the parsed JSON response from Gemini
        let parsed;
        try {
            // Safety check: Gemini sometimes returns undefined
            if (!result?.text) {
                console.warn('[Analyzer] Gemini returned empty response');
                parsed = {};
            } else {
                parsed = JSON.parse(result.text);
            }
        } catch (err) {
            console.error('[Analyzer] Invalid JSON from Gemini:', err);
            parsed = {}; // Fallback for analyzer to continue safely
        }
        // Normalize and sanitize the AI output
        const analysis = {
            topics: Array.isArray(parsed.topics) ? parsed.topics : [],

            // Normalize sentiment data into a fixed object shape with defaults

            sentiment: {
                avg: parsed?.sentiment?.avg ?? 0,
                min: parsed?.sentiment?.min ?? 0,
                negative_ratio: parsed?.sentiment?.negative_ratio ?? 0
            },
            // Ensure events is an array to prevent crashes when iterating later
            events: Array.isArray(parsed.events) ? parsed.events : []
        };

        // Log events if any were detected (CONFLICT, HELP_REQUEST, etc.)
        if (analysis.events.length > 0) {
            console.log(`[Analyzer] Events detected:`, analysis.events);
        }

        debugLog(`[Analyzer] Gemini Result:`, JSON.stringify(analysis, null, 2));

        // Persist results (Stats + Topics + Observations)
        await updateDatabase(guildId, analysis, newMessages.length, newMessages);

        // Update ServerState with text analysis results to bridge text intelligence with the intervention planner
        try {
            // Lazy load server state functions
            const { getServerState, updateServerState, checkTriggers } = require('./server-state');

            // Get previous state to calculate mood trend
            const previousState = await getServerState(guildId);
            const previousMood = previousState?.moodScore || 0;
            const currentMood = analysis.sentiment.avg;

            // Determine mood trend based on change magnitude
            // Rising: mood improved by > 0.2, Falling: mood dropped by > 0.2
            let moodTrend = 'stable';
            if (currentMood - previousMood > 0.2) moodTrend = 'rising';
            if (currentMood - previousMood < -0.2) moodTrend = 'falling';

            console.log(`[Analyzer] Updating ServerState: mood=${currentMood.toFixed(2)}, trend=${moodTrend}`);

            // Find the most active source channel (for targeted interventions)
            // Count frequency of each channel in the batch
            /** @type {{ [key: string]: number }} */
            const channelCounts = {};
            for (const m of /** @type {MessageRow[]} */ (newMessages)) {
                const key = m.channel_id || m.channel_name; // Prefer ID, fallback to name
                channelCounts[key] = (channelCounts[key] || 0) + 1;
            }
            // Find channel with most messages
            /** @type {string|null} */
            let sourceChannelId = null;
            /** @type {string|null} */
            let sourceChannelName = null;
            let maxCount = 0;
            for (const [key, count] of Object.entries(channelCounts)) {
                if (count > maxCount) {
                    maxCount = count;
                    // Check if key looks like an ID (all digits) or a name
                    if (/^\d+$/.test(key)) {
                        sourceChannelId = key;
                        // Find corresponding name from messages
                        const match = /** @type {MessageRow[]} */ (newMessages).find((/** @type {MessageRow} */ m) => m.channel_id === key);
                        sourceChannelName = match?.channel_name || null;
                    } else {
                        sourceChannelName = key;
                        // Find corresponding ID from messages
                        const match = /** @type {MessageRow[]} */ (newMessages).find((/** @type {MessageRow} */ m) => m.channel_name === key);
                        sourceChannelId = match?.channel_id || null;
                    }
                }
            }

            // Update ServerState with text analysis results
            // Use returned state directly (don't re-fetch from DB, or we lose recentEvents)
            const state = await updateServerState(guildId, {
                moodScore: currentMood,
                moodTrend,
                dominantTopics: analysis.topics.map((/** @type {Topic} */ t) => t.topic).slice(0, 5),
                recentEvents: analysis.events || [],  // Include events for conflict detection
                source: 'text',
                confidence: 0.8,  // Text analysis has high confidence
                sourceChannelId: sourceChannelId || undefined,  // Target channel for interventions
                sourceChannelName: sourceChannelName || undefined,
            });

            // Check if any intervention triggers are met
            const triggers = checkTriggers(state);

            console.log(`[Analyzer] Triggers check: found ${triggers.length} triggers`, triggers);

            // If triggers detected, fire intervention planner
            if (triggers.length > 0) {
                console.log(`[Analyzer] Firing intervention planner...`);

                // Lazy-load intervention planner to avoid circular dependencies
                try {
                    const { triggerIntervention } = require('./intervention-planner');
                    await triggerIntervention(guildId, triggers, state);
                } catch (plannerErr) {
                    // Planner might not exist yet during development
                    console.error(`[Analyzer] Intervention planner error: ${/** @type {Error} */ (plannerErr).message}`);
                }
            }

        } catch (stateErr) { // Error handling
            // ServerState update should not break analysis flow
            console.error('[Analyzer] Failed to update ServerState:', /** @type {Error} */(stateErr).message);
        }

        // Dynamic batching logic

        // Calculate active users for baseline
        const activeUsers = new Set(/** @type {MessageRow[]} */(newMessages).map((/** @type {MessageRow} */ m) => m.user_id)).size;

        // Calculate current rate (messages / minute)
        // Time diff since last run (in minutes)
        const timeSinceLastRunMins = Math.max(1, (Date.now() - lastRunTime) / 60000);
        const currentRate = newMessages.length / timeSinceLastRunMins;

        // Update moving average (weighted: 80% old, 20% new)
        const newRateAvg = (oldRateAvg * 0.8) + (currentRate * 0.2);

        // Calculate baseline threshold based on size (Bigger server = larger batch)
        // Rule: Clamp(10, 50, ActiveUsers / 2)
        const baseline = Math.min(50, Math.max(10, Math.floor(activeUsers / 2)));

        // Determine next threshold
        let nextThreshold = baseline;
        let planningNote = 'Normal';

        // Detect spikes: If current rate > 2x historical average
        if (currentRate > (oldRateAvg * 2.0) && currentRate > 5) {
            // In spike mode, lower threshold to analyze faster
            nextThreshold = Math.max(10, Math.floor(baseline / 2));
            planningNote = 'Spike Detected';
        }

        // Update cursor and metrics
        const newLastId = newMessages[newMessages.length - 1].id;

        await conn.query(
            `INSERT INTO analysis_cursor (guild_id, last_message_id, target_threshold, msg_rate_avg) 
             VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
                last_message_id = ?, 
                target_threshold = ?, 
                msg_rate_avg = ?`,
            [guildId, newLastId, nextThreshold, newRateAvg, newLastId, nextThreshold, newRateAvg]
        );

        // Log system metric for debugging /dashboard purposes
        await conn.query(
            'INSERT INTO observations (type, data, confidence, channel_id) VALUES (?, ?, ?, ?)',
            [
                'SYSTEM_METRIC',
                JSON.stringify({
                    desc: `Planner: ${planningNote}`,
                    stats: {
                        rate_now: currentRate.toFixed(1),
                        rate_avg: newRateAvg.toFixed(1),
                        next_target: nextThreshold,
                        active_users: activeUsers
                    }
                }),
                1.0,
                newMessages[0]?.channel_id || 'unknown'
            ]
        );

        console.log(`[Analyzer] Analysis done (${Date.now() - start}ms). Next Target: ${nextThreshold} (Rate: ${currentRate.toFixed(1)}/m)`);
        return analysis;

    } catch (err) { // Error handling
        console.error(`[Analyzer] Failed to analyze guild ${guildId}:`, err);
    } finally {
        conn.release();
    }
}

/**
 * Update all 3 db tables based on analysis result
 * @param {string} guildId - Discord guild ID
 * @param {AnalysisResult} analysis - Analysis result from Gemini
 * @param {number} msgCount - Number of messages analyzed
 * @param {MessageRow[]} rawMessages - Raw message rows from DB
 */
async function updateDatabase(guildId, analysis, msgCount, rawMessages) {

    // Get a dedicated db connection for safety
    const conn = await pool.getConnection();
    try {

        // Begin SQL transaction
        // Ensures all writes succeed or none do
        await conn.beginTransaction();

        // Format date in YYYY-MM-DD 
        const today = new Date().toISOString().slice(0, 10);

        // --- Update emerging topics (short term attention memory) ---
        // Track what the server is talking about right now, and decay old topics over time
        // also boosts topics that appear repeatedly
        if (analysis.topics) {
            for (const t of analysis.topics) {

                // Limit topic string length to DB schema limit
                const topicName = t.topic.slice(0, 64);

                // Default weight if model omitted or returned invalid value
                const weight = t.weight || 0.1;

                // Upsert with internal decay logic
                // If topic exists, update score with decayed value
                // If no, insert new topic with initial score
                // Formula: score = (old_score * 0.8) + new_weight

                const query = `
          INSERT INTO emerging_topics (topic, guild_id, score, first_seen, last_seen)
          VALUES (?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE
            score = (score * 0.8) + ?,
            last_seen = NOW()
        `;
                await conn.query(query, [topicName, guildId, weight * 10, weight * 10]); // Scale weight up for readability (0-1 -> 0-10)
            }
        }

        // --- Update daily stats (long term aggregate memory) ---
        // Capture how active and healthy the server is each day and enable historical analysis

        // Calculate active users in this batch
        // Approximation only coz true distinct count per day is expensive
        const uniqueUsers = new Set(rawMessages.map((/** @type {MessageRow} */ m) => m.user_id)).size;

        // Fetch existing daily stats if they exist
        /** @type {any[]} */
        const [rows] = await conn.query('SELECT message_count, sentiment_avg FROM daily_stats WHERE date = ? AND guild_id = ?', [today, guildId]);

        // Initialize aggregation variables
        let newMsgCount = msgCount;
        let oldAvg = 0;

        // If a row already exists, merge with it
        if (rows.length > 0) {
            newMsgCount += rows[0].message_count;
            oldAvg = rows[0].sentiment_avg;
        }

        // Average sentiment for THIS batch
        // Formula: (OldAvg * OldCount + NewAvg * NewCount) / (OldCount + NewCount)
        // Avoid div by zero
        const newBatchAvg = analysis.sentiment?.avg || 0;
        const currentTotalAvg = rows.length > 0
            ? ((oldAvg * rows[0].message_count) + (newBatchAvg * msgCount)) / newMsgCount
            : newBatchAvg;

        // Upsert daily stats
        /*
        1 - Increment message_count
        2 - Approximate active_users
        3 - Update rolling sentiment averages
        4 - Preserve worst sentiment seen today
        5 - Store snapshot of top topics
        */
        const upsertStats = `
      INSERT INTO daily_stats 
        (date, guild_id, message_count, active_users, sentiment_avg, sentiment_min, negative_ratio, top_topics)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        message_count = message_count + ?,
        active_users = active_users + ?,   -- approximate
        sentiment_avg = ?,
        sentiment_min = LEAST(sentiment_min, ?),
        negative_ratio = ?,  -- snapshot
        top_topics = VALUES(top_topics)
    `;

        await conn.query(upsertStats, [

            // Insert values
            today, guildId, msgCount, uniqueUsers,
            newBatchAvg, // Initial insert value
            analysis.sentiment?.min || 0,
            analysis.sentiment?.negative_ratio || 0,
            JSON.stringify(analysis.topics || []),

            // Update values
            msgCount,
            uniqueUsers,
            currentTotalAvg,
            analysis.sentiment?.min || 0,
            analysis.sentiment?.negative_ratio || 0
        ]);

        // --- Log observations (discrete notable events) ---
        // Log specific AI detected events and feed the planner (to be implemented)
        // Provide audit trail for admins
        if (analysis.events && analysis.events.length > 0) {
            for (const ev of analysis.events) {

                // Ignore low-confidence detections to reduce noise
                if (ev.confidence < 0.6) continue;

                await conn.query(
                    'INSERT INTO observations (type, data, confidence, channel_id) VALUES (?, ?, ?, ?)',
                    [
                        ev.type,
                        JSON.stringify({ desc: ev.desc, sentiment: analysis.sentiment }),
                        ev.confidence,
                        rawMessages[0]?.channel_id || 'unknown'
                    ]
                );
            }
        }

        // --- Sentiment sentinel (fail safe detector) ---
        // Catch conflicts even if the LLM fails to emit an event, for safety purposes
        const minSent = analysis.sentiment?.min || 0;
        const negRatio = analysis.sentiment?.negative_ratio || 0;

        // Noise filtering, hard thresholds for dangerous conversations
        if (minSent < -0.7 || negRatio > 0.3) {
            // Create a specific observation for conflict if the analyzer didn't already
            const conflictMsg = `High negative sentiment detected (Min: ${minSent}, Ratio: ${negRatio})`;

            await conn.query(
                'INSERT INTO observations (type, data, confidence, channel_id) VALUES (?, ?, ?, ?)',
                ['SENTIMENT_SPIKE', JSON.stringify({ desc: conflictMsg }), 0.9, rawMessages[0]?.channel_id || 'unknown']
            );
            console.log(`[Analyzer] Sentinel Triggered: ${conflictMsg}`);
        }

        // Commit all changes atomically
        await conn.commit();

    } catch (err) {
        // Roll back everything if ANY error occurs
        await conn.rollback();
        throw err;

    } finally {
        // Always return the connection to the pool
        conn.release();
    }
}

module.exports = {
    analyzeGuild,
};
