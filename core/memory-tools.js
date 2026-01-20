// core/memory-tools.js
// Memory Search Tools for Gemini Function Calling
// Allows AI to fetch context on-demand instead of dumping everything upfront

// ============================================================================
// ARCHITECTURE OVERVIEW
// ============================================================================
//
// Problem: Context is channel-siloed, dumping all wastes tokens
// Solution: AI requests what it needs → we fetch and return
//
// User: "Yesterday #dev was discussing what?"
// AI calls: search_channel_history({ channelId: "dev", query: "*" })
// Tool returns: Relevant messages/summary → AI responds
//
// ============================================================================

const { pool } = require('../db');
const { getServerState } = require('./server-state');
const { debugLog } = require('../utils/debugging');

// ============================================================================
// FUNCTION DECLARATIONS (for Gemini tool use)
// ============================================================================

/**
 * Tool definitions for Gemini function calling
 * These enable the AI to request context on-demand
 */
const memoryToolDeclarations = [
    {
        name: 'search_channel_history',
        description: 'Search for messages or topics in a channel or server-wide. Use when user asks about past discussions.',
        parameters: {
            type: 'OBJECT',
            properties: {
                channelId: {
                    type: 'STRING',
                    description: 'Channel ID to search. Use "all" for server-wide search.'
                },
                query: {
                    type: 'STRING',
                    description: 'What to search for (topic, keyword, or user)'
                },
                timeRange: {
                    type: 'STRING',
                    description: '"today", "week", or "month". Default: "week"',
                    enum: ['today', 'week', 'month']
                }
            },
            required: ['query']
        }
    },
    {
        name: 'get_channel_summary',
        description: 'Get the AI-generated summary of one or more channels. Use when user asks about general activity.',
        parameters: {
            type: 'OBJECT',
            properties: {
                channelIds: {
                    type: 'ARRAY',
                    items: { type: 'STRING' },
                    description: 'Array of channel IDs to get summaries for'
                }
            },
            required: ['channelIds']
        }
    },
    {
        name: 'get_server_state',
        description: 'Get the current server mood, trending topics, and recent activity. Use when user asks about server vibe or sentiment.',
        parameters: {
            type: 'OBJECT',
            properties: {},
            required: []
        }
    }
];

// ============================================================================
// TOOL EXECUTION FUNCTIONS
// ============================================================================

/**
 * Search channel history for messages matching a query
 * 
 * @param {string} guildId - Discord guild ID
 * @param {any} args - Function arguments from Gemini
 * @returns {Promise<Object>} - Search results
 */
async function executeSearchChannelHistory(guildId, args) {
    const { channelId = 'all', query, timeRange = 'week' } = args;

    debugLog(`[MemoryTools] Searching: ${query} in ${channelId} (${timeRange})`);

    // Calculate time filter
    const timeFilters = {
        today: 'INTERVAL 1 DAY',
        week: 'INTERVAL 7 DAY',
        month: 'INTERVAL 30 DAY'
    };
    // @ts-ignore
    const timeFilter = timeFilters[timeRange] || timeFilters.week;

    const conn = await pool.getConnection();
    try {
        let sql;
        let params;

        if (channelId === 'all') {
            // Server-wide search
            sql = `
                SELECT m.content, m.author_name, m.created_at, c.name as channel_name
                FROM messages m
                JOIN channels c ON m.channel_id = c.channel_id
                WHERE m.guild_id = ? 
                  AND m.created_at > NOW() - ${timeFilter}
                  AND m.content LIKE ?
                ORDER BY m.created_at DESC
                LIMIT 20
            `;
            params = [guildId, `%${query}%`];
        } else {
            // Channel-specific search
            sql = `
                SELECT m.content, m.author_name, m.created_at
                FROM messages m
                WHERE m.guild_id = ? 
                  AND m.channel_id = ?
                  AND m.created_at > NOW() - ${timeFilter}
                  AND m.content LIKE ?
                ORDER BY m.created_at DESC
                LIMIT 20
            `;
            params = [guildId, channelId, `%${query}%`];
        }

        /** @type {any[]} */
        const [rows] = await conn.query(sql, params);

        if (rows.length === 0) {
            return {
                found: false,
                message: `No messages found matching "${query}" in the last ${timeRange}.`
            };
        }

        // Format results for AI consumption
        const results = rows.map((/** @type {any} */ r) => ({
            author: r.author_name,
            content: r.content.substring(0, 200), // Truncate for token efficiency
            channel: r.channel_name || 'this channel',
            time: r.created_at
        }));

        return {
            found: true,
            count: results.length,
            timeRange,
            results
        };

    } finally {
        conn.release();
    }
}

/**
 * Get summaries for specified channels
 * 
 * @param {string} guildId - Discord guild ID
 * @param {any} args - Function arguments from Gemini
 * @returns {Promise<Object>} - Channel summaries
 */
async function executeGetChannelSummary(guildId, args) {
    const { channelIds } = args;

    debugLog(`[MemoryTools] Getting summaries for ${channelIds.length} channels`);

    const conn = await pool.getConnection();
    try {
        const placeholders = channelIds.map(() => '?').join(',');
        /** @type {any[]} */
        const [rows] = await conn.query(`
            SELECT channel_id, name, summary, updated_at
            FROM channels
            WHERE guild_id = ? AND channel_id IN (${placeholders})
        `, [guildId, ...channelIds]);

        if (rows.length === 0) {
            return {
                found: false,
                message: 'No summaries available for the specified channels.'
            };
        }

        // Group summaries
        const summaries = rows.map((/** @type {any} */ r) => ({
            id: r.channel_id,
            name: r.name,
            summary: r.summary || 'No summary available yet.',
            lastUpdated: r.updated_at
        }));

        return {
            found: true,
            count: summaries.length,
            summaries
        };

    } finally {
        conn.release();
    }
}

/**
 * Get current server state (mood, topics, activity)
 * 
 * @param {string} guildId - Discord guild ID
 * @returns {Promise<Object>} - Server state
 */
async function executeGetServerState(guildId) {
    debugLog(`[MemoryTools] Getting server state for ${guildId}`);

    try {
        const state = await getServerState(guildId);

        // Format for AI consumption
        let moodDescription;
        if (state.moodScore < -0.5) moodDescription = 'negative/stressed';
        else if (state.moodScore < -0.2) moodDescription = 'slightly tense';
        else if (state.moodScore > 0.5) moodDescription = 'very positive';
        else if (state.moodScore > 0.2) moodDescription = 'positive';
        else moodDescription = 'neutral';

        return {
            mood: {
                score: state.moodScore,
                description: moodDescription,
                trend: state.moodTrend
            },
            topics: state.dominantTopics,
            dominantSignal: state.dominantSignal,
            lastVoiceSummary: state.lastVoiceSummary,
            lastUpdated: state.lastUpdated
        };

    } catch (err) {
        return {
            error: true,
            message: 'Could not retrieve server state.'
        };
    }
}

/**
 * Execute a memory tool by name
 * Called by gemini-orchestrator when AI requests a tool
 * 
 * @param {string} toolName - Name of the tool to execute
 * @param {string} guildId - Discord guild ID
 * @param {any} args - Arguments from Gemini
 * @returns {Promise<Object>} - Tool result
 */
async function executeMemoryTool(toolName, guildId, args) {
    switch (toolName) {
        case 'search_channel_history':
            return await executeSearchChannelHistory(guildId, args);
        case 'get_channel_summary':
            return await executeGetChannelSummary(guildId, args);
        case 'get_server_state':
            return await executeGetServerState(guildId);
        default:
            return { error: true, message: `Unknown memory tool: ${toolName}` };
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    memoryToolDeclarations,
    executeMemoryTool,
    // Export individual executors for testing
    executeSearchChannelHistory,
    executeGetChannelSummary,
    executeGetServerState,
};
