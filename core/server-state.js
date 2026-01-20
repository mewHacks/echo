// core/server-state.js
// Unified ServerState module for cross-modal intelligence
// This module bridges TEXT analysis and VOICE summaries into a shared state
// that the Intervention Planner can use to make decisions.

// ============================================================================
// ARCHITECTURE OVERVIEW
// ============================================================================
// 
// Text (analyzer.js)  ──┐
//                       ├──> updateServerState() ──> server_state table
// Voice (voiceSessionManager.js) ──┘
//                                          │
//                                          ▼
//                                   checkTriggers()
//                                          │
//                                          ▼
//                              triggerIntervention() (intervention-planner.js)
//
// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * @typedef {Object} ContextMarker
 * @property {string} type - Marker type (e.g., 'high_stress_period')
 * @property {number} confidence - Confidence in this marker (0.0-1.0)
 * @property {string|null} topic - Related topic
 * @property {Date} since - When this marker was created
 * @property {Date} expiresAt - When this marker expires
 */

/**
 * Database row shape for server_state table
 * @typedef {Object} ServerStateRow
 * @property {string} guild_id
 * @property {number} mood_score
 * @property {string} mood_trend
 * @property {string} dominant_topics - JSON string
 * @property {string} open_commitments - JSON string
 * @property {string} context_markers - JSON string
 * @property {string|null} last_voice_summary
 * @property {Date|null} last_voice_timestamp
 * @property {string} source
 * @property {string} dominant_signal
 * @property {number} confidence
 * @property {Date} updated_at
 */

/**
 * Event detected by the analyzer
 * @typedef {Object} AnalyzerEvent
 * @property {string} type - Event type (CONFLICT, HELP_REQUEST, etc.)
 * @property {string} desc - Event description
 * @property {number} confidence - Confidence score (0.0-1.0)
 */

/**
 * @typedef {Object} ServerState
 * @property {string} guildId - Discord guild ID
 * @property {number} moodScore - Current mood score (-1.0 to 1.0)
 * @property {string} moodTrend - 'rising', 'falling', or 'stable'
 * @property {string[]} dominantTopics - List of current dominant topics
 * @property {Object[]} openCommitments - List of commitments (unused)
 * @property {ContextMarker[]} contextMarkers - Active context markers
 * @property {string|null} lastVoiceSummary - Summary of last voice chat
 * @property {Date|null} lastVoiceTimestamp - Timestamp of last voice activity
 * @property {string} source - 'text' or 'voice' (last update source)
 * @property {string} dominantSignal - 'text', 'voice', or 'mixed' (rolling window)
 * @property {number} confidence - Confidence of the current state analysis
 * @property {Date} lastUpdated - Last state update timestamp
 * @property {AnalyzerEvent[]} [recentEvents] - Transient logic events (not persisted)
 * @property {string} [sourceChannelId] - ID of the channel where the last event occurred
 * @property {string} [sourceChannelName] - Name of the channel where the last event occurred
 */

const { pool } = require('../db');
const { debugLog } = require('../utils/debugging');

// ============================================================================
// CONFIGURATION
// ============================================================================

// Voice summaries older than this are considered stale and will be nulled out
// This prevents outdated voice context from influencing decisions
const VOICE_EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes

// Context marker expiration (default if not specified)
const CONTEXT_MARKER_EXPIRATION_MS = 30 * 60 * 1000; // 30 minutes

// Trigger thresholds for intervention planner
// These define when the system should consider taking action
const TRIGGERS = {
    MOOD_NEGATIVE: -0.5,    // If moodScore drops below this, flag as negative
    MOOD_POSITIVE: 0.7,     // If moodScore rises above this, flag as positive (celebration)
};

// In-memory cache to reduce DB reads
// Key: guildId, Value: { state, timestamp }
const stateCache = new Map();
const CACHE_TTL_MS = 30_000; // Short TTL to avoid stale moderation decisions (30 seconds)

// Track the last N sources to compute dominantSignal
// Key: guildId, Value: array of 'text' | 'voice' (max 3)
const sourceHistory = new Map();

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Get the current ServerState for a guild
 * Applies voice expiration and returns normalized state object
 * 
 * @param {string} guildId - Discord guild ID
 * @returns {Promise<ServerState>} - ServerState object with all fields
 */
async function getServerState(guildId) {
    // Check cache first to reduce DB load
    const cached = stateCache.get(guildId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        debugLog(`[ServerState] Cache hit for ${guildId}`);
        return applyVoiceExpiration(cached.state);
    }

    // Fetch from database
    const conn = await pool.getConnection();
    try {
        const [rows] = /** @type {[ServerStateRow[], any]} */ (await conn.query(
            'SELECT * FROM server_state WHERE guild_id = ?',
            [guildId]
        ));

        // If no record exists, return default state
        if (rows.length === 0) {
            debugLog(`[ServerState] No state found for ${guildId}, returning defaults`);
            return getDefaultState(guildId);
        }

        // Parse JSON fields and normalize
        const row = rows[0];
        const state = {
            guildId: row.guild_id,
            moodScore: row.mood_score || 0,
            moodTrend: row.mood_trend || 'stable',
            dominantTopics: safeJsonParse(row.dominant_topics, []),
            openCommitments: safeJsonParse(row.open_commitments, []),
            contextMarkers: safeJsonParse(row.context_markers, []),
            lastVoiceSummary: row.last_voice_summary || null,
            lastVoiceTimestamp: row.last_voice_timestamp ? new Date(row.last_voice_timestamp) : null,
            source: row.source || 'text',
            dominantSignal: row.dominant_signal || 'text',
            confidence: row.confidence || 0,
            lastUpdated: row.updated_at ? new Date(row.updated_at) : new Date(),
        };

        // Update cache
        stateCache.set(guildId, { state, timestamp: Date.now() });

        // Apply voice expiration before returning
        return applyVoiceExpiration(state);

    } finally {
        conn.release();
    }
}

/**
 * Update the ServerState with new data
 * Merges updates, computes dominantSignal, and persists to DB
 * 
 * @param {string} guildId - Discord guild ID
 * @param {Partial<ServerState>} updates - Partial state updates
 * @returns {Promise<ServerState>} - Updated state object
 */
async function updateServerState(guildId, updates) {
    debugLog(`[ServerState] Updating state for ${guildId}:`, Object.keys(updates));

    // Get current state to merge with
    const currentState = await getServerState(guildId);

    // Track source history for dominantSignal computation
    if (updates.source) {
        trackSourceHistory(guildId, updates.source);
    }

    // Compute dominantSignal based on last 3 sources
    const dominantSignal = computeDominantSignal(guildId);

    // Merge updates with current state
    const newState = {
        ...currentState,
        ...updates,
        dominantSignal,
        lastUpdated: new Date(),
    };

    // Persist to database using UPSERT (INSERT ... ON DUPLICATE KEY UPDATE)
    const conn = await pool.getConnection();
    try {
        await conn.query(
            `INSERT INTO server_state 
                (guild_id, mood_score, mood_trend, dominant_topics, open_commitments, context_markers,
                 last_voice_summary, last_voice_timestamp, source, dominant_signal, confidence)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                mood_score = VALUES(mood_score),
                mood_trend = VALUES(mood_trend),
                dominant_topics = VALUES(dominant_topics),
                open_commitments = VALUES(open_commitments),
                context_markers = VALUES(context_markers),
                last_voice_summary = VALUES(last_voice_summary),
                last_voice_timestamp = VALUES(last_voice_timestamp),
                source = VALUES(source),
                dominant_signal = VALUES(dominant_signal),
                confidence = VALUES(confidence)`,
            [
                guildId,
                newState.moodScore,
                newState.moodTrend,
                JSON.stringify(newState.dominantTopics),
                JSON.stringify(newState.openCommitments),
                JSON.stringify(newState.contextMarkers || []),
                newState.lastVoiceSummary,
                newState.lastVoiceTimestamp,
                newState.source,
                newState.dominantSignal,
                newState.confidence,
            ]
        );

        // Invalidate cache
        stateCache.delete(guildId);

        debugLog(`[ServerState] Successfully updated state for ${guildId}`);
        return newState;

    } finally {
        conn.release();
    }
}

/**
 * Check if any intervention triggers are met
 * Returns an array of trigger names that are currently active
 * 
 * @param {ServerState} state - ServerState object
 * @returns {string[]} - Array of trigger names (e.g., ['mood_negative', 'voice_activity'])
 */
function checkTriggers(state) {
    const triggers = [];

    // Check for negative mood threshold
    // Voice summaries are now analyzed for sentiment, so this works for both text and voice
    if (state.moodScore < TRIGGERS.MOOD_NEGATIVE) {
        triggers.push('mood_negative');
        debugLog(`[ServerState] Trigger: mood_negative (${state.moodScore} from ${state.source})`);
    }

    // Check for positive mood threshold (optional celebration)
    if (state.moodScore > TRIGGERS.MOOD_POSITIVE) {
        triggers.push('mood_positive');
        debugLog(`[ServerState] Trigger: mood_positive (${state.moodScore} from ${state.source})`);
    }

    // Check for recent voice activity as dominant signal
    // This enables cross-modal reasoning (voice tension -> text intervention)
    if (state.lastVoiceSummary) {
        triggers.push('voice_activity');
        debugLog(`[ServerState] Trigger: voice_activity`);

        // Safety scan moved to voiceSessionManager.js to process PER-SEGMENT instead of scanning full history
        // This prevents old "stalking" mentions from re-triggering alerts on every new sentence
    }

    // Check for conflict/quarrel detection
    // recentEvents is an array from the analyzer with events like CONFLICT, HELP_REQUEST, etc.
    if (state.recentEvents && Array.isArray(state.recentEvents)) {
        for (const e of state.recentEvents) {
            if ((e.type === 'CONFLICT' || e.type === 'HELP_REQUEST' || e.type === 'SAFETY_RISK') && e.confidence >= 0.7) {
                // Push actual event type so intervention-planner can apply correct cooldown tier
                triggers.push(e.type);
                debugLog(`[ServerState] Trigger: ${e.type} (${e.desc})`);
            }
        }
    }

    return triggers;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get default state for a guild that has no existing record
 *
 * @param {string} guildId - Discord guild ID
 * @returns {ServerState} - Default ServerState object
 */
function getDefaultState(guildId) {
    return {
        guildId,
        moodScore: 0,
        moodTrend: 'stable',
        dominantTopics: [],
        openCommitments: [],
        contextMarkers: [],
        lastVoiceSummary: null,
        lastVoiceTimestamp: null,
        source: 'text',
        dominantSignal: 'text',
        confidence: 0,
        lastUpdated: new Date(),
    };
}

/**
 * Apply voice expiration logic
 * If voice summary is older than VOICE_EXPIRATION_MS, null it out
 * This prevents stale voice context from affecting decisions
 *
 * @param {ServerState} state - ServerState object
 * @returns {ServerState} - State with voice expiration applied
 */
function applyVoiceExpiration(state) {
    if (state.lastVoiceTimestamp) {
        const age = Date.now() - new Date(state.lastVoiceTimestamp).getTime();
        if (age > VOICE_EXPIRATION_MS) {
            debugLog(`[ServerState] Voice summary active period expired (${Math.round(age / 60000)} min old)`);
            return {
                ...state,
                // Keep the summary for context (up to 4 hours)
                // but reset signal so Planner knows we aren't "live" right now
                source: 'text',
                dominantSignal: 'text',
            };
        }
    }
    return state;
}

/**
 * Track source history for dominantSignal computation
 * Keeps last 3 sources per guild
 * 
 * @param {string} guildId - Discord guild ID
 * @param {string} source - 'text' or 'voice'
 */
function trackSourceHistory(guildId, source) {
    if (!sourceHistory.has(guildId)) {
        sourceHistory.set(guildId, []);
    }
    const history = sourceHistory.get(guildId);
    history.push(source);

    // Keep only last 3
    if (history.length > 3) {
        history.shift();
    }
}

/**
 * Compute dominantSignal based on last 3 sources
 * Returns 'text', 'voice', or 'mixed'
 * 
 * @param {string} guildId - Discord guild ID
 * @returns {string} - 'text' | 'voice' | 'mixed'
 */
function computeDominantSignal(guildId) {
    const history = sourceHistory.get(guildId) || [];

    if (history.length === 0) return 'text';

    const textCount = history.filter((/** @type {string} */ s) => s === 'text').length;
    const voiceCount = history.filter((/** @type {string} */ s) => s === 'voice').length;

    // If all same source, return that source
    if (textCount === history.length) return 'text';
    if (voiceCount === history.length) return 'voice';

    // Otherwise, it's mixed
    return 'mixed';
}

/**
 * Safely parse JSON with a fallback value
 * Prevents crashes from malformed JSON in DB
 * 
 * @param {string} jsonString - JSON string to parse
 * @param {*} fallback - Fallback value if parse fails
 * @returns {*} - Parsed value or fallback
 */
function safeJsonParse(jsonString, fallback) {
    if (!jsonString) return fallback;
    try {
        return JSON.parse(jsonString);
    } catch (e) {
        debugLog(`[ServerState] JSON parse error: ${/** @type {Error} */ (e).message}`);
        return fallback;
    }
}

// ============================================================================
// CONTEXT MARKER FUNCTIONS
// ============================================================================

/**
 * Context Marker Types:
 * - 'high_stress_period' - Team is under deadline pressure
 * - 'unresolved_tension' - Conflict not yet resolved
 * - 'decision_pending' - Team is deciding something
 * - 'celebration' - Positive event happened
 * - 'voice_tension' - Tension detected in voice chat
 */

/**
 * Set a context marker for a guild
 * Markers influence future intervention decisions by providing anticipatory context
 * 
 * @param {string} guildId - Discord guild ID
 * @param {Object} marker - Marker object
 * @param {string} marker.type - Marker type (e.g., 'high_stress_period')
 * @param {number} [marker.confidence] - Confidence in this marker (0.0-1.0)
 * @param {string} [marker.topic] - Related topic (optional)
 * @param {number} [marker.ttlMs] - Time-to-live in ms (default: 30 minutes)
 * @returns {Promise<Object>} - Updated state
 */
async function setContextMarker(guildId, marker) {
    const state = await getServerState(guildId);
    const markers = Array.isArray(state.contextMarkers) ? [...state.contextMarkers] : [];

    // Calculate expiration time
    const ttlMs = marker.ttlMs || CONTEXT_MARKER_EXPIRATION_MS;
    const expiresAt = new Date(Date.now() + ttlMs);

    // Create the new marker
    const newMarker = {
        type: marker.type,
        confidence: marker.confidence || 0.7,
        topic: marker.topic || null,
        since: new Date(),
        expiresAt,
    };

    // Check if marker of this type already exists
    const existingIndex = markers.findIndex(m => m.type === marker.type);

    if (existingIndex >= 0) {
        // Update existing marker
        markers[existingIndex] = newMarker;
        debugLog(`[ServerState] Updated context marker: ${marker.type}`);
    } else {
        // Add new marker
        markers.push(newMarker);
        debugLog(`[ServerState] Added context marker: ${marker.type}`);
    }

    // Update state with new markers
    return updateServerState(guildId, { contextMarkers: markers });
}

/**
 * Get active (non-expired) context markers for a guild
 * Automatically filters out expired markers
 * 
 * @param {string} guildId - Discord guild ID
 * @returns {Promise<Object[]>} - Array of active markers
 */
async function getActiveContextMarkers(guildId) {
    const state = await getServerState(guildId);
    const markers = Array.isArray(state.contextMarkers) ? state.contextMarkers : [];

    const now = Date.now();
    const activeMarkers = markers.filter(m => {
        if (!m.expiresAt) return true; // No expiration = always active
        return new Date(m.expiresAt).getTime() > now;
    });

    // If we filtered out expired markers, update the state
    if (activeMarkers.length < markers.length) {
        debugLog(`[ServerState] Cleared ${markers.length - activeMarkers.length} expired context markers`);
        await updateServerState(guildId, { contextMarkers: activeMarkers });
    }

    return activeMarkers;
}

/**
 * Clear a specific context marker by type
 * 
 * @param {string} guildId - Discord guild ID
 * @param {string} markerType - Type of marker to clear
 * @returns {Promise<Object>} - Updated state
 */
async function clearContextMarker(guildId, markerType) {
    const state = await getServerState(guildId);
    const markers = Array.isArray(state.contextMarkers) ? state.contextMarkers : [];

    const filteredMarkers = markers.filter(m => m.type !== markerType);

    if (filteredMarkers.length < markers.length) {
        debugLog(`[ServerState] Cleared context marker: ${markerType}`);
        return updateServerState(guildId, { contextMarkers: filteredMarkers });
    }

    return state;
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    getServerState,
    updateServerState,
    checkTriggers,
    setContextMarker,
    getActiveContextMarkers,
    clearContextMarker,
    TRIGGERS,
    VOICE_EXPIRATION_MS,
    CONTEXT_MARKER_EXPIRATION_MS,
};
