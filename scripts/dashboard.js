// scripts/dashboard.js
// Live CLI Dashboard for echo intelligence
// Run in another terminal: node scripts/dashboard.js
// Options:
//   --list          Show available guilds and exit
//   --guild <id>    Filter dashboard to specific guild
//   (no args)       Show all guilds (default)

require('dotenv').config();
const { pool } = require('../db');

// ANSI colors
const C = {
    RESET: '\x1b[0m',
    BRIGHT: '\x1b[1m',
    DIM: '\x1b[2m',
    GREEN: '\x1b[32m',
    RED: '\x1b[31m',
    YELLOW: '\x1b[33m',
    BLUE: '\x1b[34m',
    CYAN: '\x1b[36m',
};

// Parse command line arguments
function parseArgs() {
    // Get command line arguments and initialize options
    const args = process.argv.slice(2);
    const options = { guildId: null, listGuilds: false };

    // For each argument, check if it matches a known option
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--list') {
            options.listGuilds = true;
        } else if (args[i] === '--guild' && args[i + 1]) {
            options.guildId = args[i + 1];
            i++; // Skip next arg
        }
    }
    return options;
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * @typedef {Object} DashboardData
 * @property {Object} stats - Daily stats (message count, active users, sentiment)
 * @property {Array<{topic: string, score: number}>} topics - Trending topics
 * @property {Array<{type: string, data: string, confidence: number, created_at: Date}>} obs - Recent observations
 * @property {Array<{guild_id: string, mood_score: number, mood_trend: string, dominant_signal: string}>} serverStates - Server states
 * @property {Array<{trigger_type: string, action_taken: string, reasoning: string, confidence: number, created_at: Date}>} interventions - Intervention history
 */

// ============================================================================
// DATABASE QUERIES
// ============================================================================

/**
 * Fetch list of known guilds from server_state table
 * @returns {Promise<Array<{guild_id: string, updated_at: Date}>>}
 */
async function fetchGuilds() {
    const conn = await pool.getConnection();
    try {
        const [rows] = await conn.query(
            'SELECT guild_id, mood_score, updated_at FROM server_state ORDER BY updated_at DESC'
        );
        return rows;
    } finally {
        conn.release();
    }
}

/**
 * Fetch dashboard data, optionally filtered by guild
 * @param {string|null} guildId - Guild ID to filter by, or null for all guilds
 * @returns {Promise<DashboardData>}
 */
async function fetchStats(guildId = null) {
    const conn = await pool.getConnection();
    try {
        const today = new Date().toISOString().slice(0, 10);

        // Daily stats - filter by guild if provided
        /** @type {any[]} */
        const [stats] = guildId
            ? await conn.query(
                'SELECT * FROM daily_stats WHERE date = ? AND guild_id = ? LIMIT 1',
                [today, guildId]
            )
            : await conn.query(
                'SELECT * FROM daily_stats WHERE date = ? ORDER BY message_count DESC LIMIT 1',
                [today]
            );

        // Emerging topics - filter by guild if provided
        /** @type {any[]} */
        const [topics] = guildId
            ? await conn.query(
                'SELECT topic, score FROM emerging_topics WHERE guild_id = ? ORDER BY score DESC LIMIT 5',
                [guildId]
            )
            : await conn.query(
                'SELECT topic, score FROM emerging_topics ORDER BY score DESC LIMIT 5'
            );

        // Recent observations - no guild_id column, always global
        /** @type {any[]} */
        const [obs] = await conn.query(
            'SELECT type, data, confidence, created_at FROM observations ORDER BY created_at DESC LIMIT 5'
        );

        // Server states - filter by guild if provided
        /** @type {any[]} */
        const [serverStates] = guildId
            ? await conn.query(
                'SELECT guild_id, mood_score, mood_trend, dominant_signal, updated_at FROM server_state WHERE guild_id = ?',
                [guildId]
            )
            : await conn.query(
                'SELECT guild_id, mood_score, mood_trend, dominant_signal, updated_at FROM server_state ORDER BY updated_at DESC LIMIT 3'
            );

        // Recent interventions - filter by guild if provided
        /** @type {any[]} */
        const [interventions] = guildId
            ? await conn.query(
                'SELECT trigger_type, action_taken, reasoning, confidence, created_at FROM intervention_history WHERE guild_id = ? ORDER BY created_at DESC LIMIT 5',
                [guildId]
            )
            : await conn.query(
                'SELECT trigger_type, action_taken, reasoning, confidence, created_at FROM intervention_history ORDER BY created_at DESC LIMIT 5'
            );

        return {
            stats: stats[0] || {},
            topics,
            obs,
            serverStates,
            interventions
        };
    } finally {
        conn.release();
    }
}

// ============================================================================
// RENDER FUNCTIONS
// ============================================================================

/**
 * Display list of available guilds
 * @param {Array<{guild_id: string, mood_score: number, updated_at: Date}>} guilds
 */
function renderGuildList(guilds) {
    console.log(`\n${C.BRIGHT}${C.CYAN}Available Guilds${C.RESET}\n`);
    console.log('----------------------------------------------------------');

    if (guilds.length === 0) {
        console.log(`${C.DIM}(No guilds found in server_state)${C.RESET}`);
        return;
    }

    guilds.forEach((g, i) => {
        const moodColor = g.mood_score > 0.2 ? C.GREEN : g.mood_score < -0.2 ? C.RED : C.YELLOW;
        const updated = new Date(g.updated_at).toLocaleString();
        console.log(`${C.BRIGHT}[${i + 1}]${C.RESET} ${g.guild_id} | Mood: ${moodColor}${g.mood_score?.toFixed(2) || '0.00'}${C.RESET} | ${C.DIM}${updated}${C.RESET}`);
    });

    console.log(`\n${C.DIM}Usage: node scripts/dashboard.js --guild <guild_id>${C.RESET}\n`);
}

/**
 * Render the dashboard to terminal
 * @param {DashboardData} data
 * @param {string|null} guildId - Currently filtered guild, or null for all
 */
function render(data, guildId = null) {
    // Clear screen and reset cursor
    process.stdout.write('\x1b[2J\x1b[0f');

    const { stats, topics, obs, serverStates, interventions } = data;
    const now = new Date().toLocaleTimeString();

    // Header with filter indicator
    const filterText = guildId ? `Guild: ...${guildId.slice(-6)}` : 'All Guilds';
    console.log(`${C.BRIGHT}${C.CYAN}╔════════════════════════════════════════════════════════╗`);
    console.log(`║               ECHO INTELLIGENCE DASHBOARD              ║`);
    console.log(`║  ${C.YELLOW}${filterText.padEnd(20)}${C.CYAN}              ${C.DIM}${now.padEnd(14)}${C.CYAN}║`);
    console.log(`╚════════════════════════════════════════════════════════╝${C.RESET}\n`);

    // Server States Section
    console.log(`${C.BRIGHT}🧠 SERVER STATES${C.RESET}`);
    console.log(`----------------------------------------------------------`);
    if (!serverStates || serverStates.length === 0) {
        console.log(`${C.DIM}(No server states yet)${C.RESET}`);
    } else {
        serverStates.forEach(s => {
            const moodScore = s.mood_score || 0;
            const moodColor = moodScore > 0.2 ? C.GREEN : moodScore < -0.2 ? C.RED : C.YELLOW;
            const guildShort = s.guild_id.slice(-6);
            const trend = s.mood_trend || 'stable';
            const signal = s.dominant_signal || 'text';
            console.log(`Guild ...${guildShort} | Mood: ${moodColor}${moodScore.toFixed(2)}${C.RESET} (${trend}) | Signal: ${signal}`);
        });
    }
    console.log('');

    // Intervention Log Section
    console.log(`${C.BRIGHT}⚡ INTERVENTION LOG${C.RESET}`);
    console.log(`----------------------------------------------------------`);
    if (!interventions || interventions.length === 0) {
        console.log(`${C.DIM}(No interventions yet)${C.RESET}`);
    } else {
        interventions.forEach(i => {
            const time = new Date(i.created_at).toLocaleTimeString();
            const action = i.action_taken || 'UNKNOWN';
            const conf = i.confidence || 0;
            const confColor = conf >= 0.7 ? C.GREEN : conf >= 0.5 ? C.YELLOW : C.RED;
            const reason = (i.reasoning || '').slice(0, 45) + (i.reasoning?.length > 45 ? '...' : '');
            console.log(`${C.DIM}[${time}]${C.RESET} ${action.padEnd(12)} ${confColor}(${conf.toFixed(2)})${C.RESET} ${reason}`);
        });
    }
    console.log('');

    // Today's Pulse
    const sentAvg = stats.sentiment_avg || 0;
    const pulseChars = ['♥', '♡'];
    const pulseFrame = Math.floor(Date.now() / 1000) % 2; // Beat every second
    const heart = sentAvg < -0.2 ? C.RED + pulseChars[pulseFrame] : C.GREEN + pulseChars[pulseFrame];

    console.log(`${C.BRIGHT}📊 TODAY'S PULSE ${heart}${C.RESET}`);
    console.log(`----------------------------------------------------------`);
    console.log(`Messages  : ${stats.message_count || 0}`);
    console.log(`Users     : ${stats.active_users || 0}`);

    const sentColor = sentAvg > 0.2 ? C.GREEN : sentAvg < -0.2 ? C.RED : C.YELLOW;
    console.log(`Sentiment : ${sentColor}${sentAvg.toFixed(2)}${C.RESET} (Min: ${stats.sentiment_min?.toFixed(2) || 0})`);

    const negColor = (stats.negative_ratio || 0) > 0.2 ? C.RED : C.GREEN;
    console.log(`Neg Ratio : ${negColor}${((stats.negative_ratio || 0) * 100).toFixed(1)}%${C.RESET}`);
    console.log('');

    // Trending Topics
    console.log(`${C.BRIGHT}🔥 TRENDING TOPICS${C.RESET}`);
    console.log(`----------------------------------------------------------`);
    if (topics.length === 0) console.log(`${C.DIM}(No topics yet)${C.RESET}`);
    const maxScore = Math.max(...topics.map(t => t.score), 1);
    topics.forEach((t, i) => {
        const barLength = Math.floor((t.score / maxScore) * 20);
        const bar = '█'.repeat(barLength);
        console.log(`${i + 1}. ${C.YELLOW}${t.topic.padEnd(20)}${C.RESET} ${C.DIM}[${t.score.toFixed(1)}]${C.RESET} ${bar}`);
    });
    console.log('');

    // Recent Observations (always global)
    console.log(`${C.BRIGHT}👁️ RECENT OBSERVATIONS${C.RESET} ${C.DIM}(global)${C.RESET}`);
    console.log(`----------------------------------------------------------`);
    if (obs.length === 0) console.log(`${C.DIM}(No observations yet)${C.RESET}`);
    obs.forEach(o => {
        const time = new Date(o.created_at).toLocaleTimeString();
        let typeColor = C.RESET;
        if (o.type.includes('SPIKE')) typeColor = C.YELLOW;
        if (o.type.includes('DIP') || o.type.includes('CONFLICT')) typeColor = C.RED;

        let desc = '';
        try {
            const json = JSON.parse(o.data);
            desc = json.desc || JSON.stringify(json);
        } catch {
            desc = String(o.data);
        }
        if (desc.length > 50) desc = desc.slice(0, 47) + '...';
        console.log(`${C.DIM}[${time}]${C.RESET} ${typeColor}${o.type.padEnd(15)}${C.RESET} ${desc}`);
    });
    console.log(`\n${C.DIM}Press Ctrl+C to exit.${C.RESET}`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
    const options = parseArgs();

    console.log('Connecting to database...');

    try {
        // --list mode: show guilds and exit
        if (options.listGuilds) {
            const guilds = await fetchGuilds();
            renderGuildList(guilds);
            process.exit(0);
        }

        // Normal dashboard mode
        const guildId = options.guildId;
        if (guildId) {
            console.log(`Filtering to guild: ${guildId}`);
        }

        // Initial fetch
        const data = await fetchStats(guildId);
        render(data, guildId);

        // Refresh dashboard every 5 seconds
        setInterval(async () => {
            try {
                const data = await fetchStats(guildId);
                render(data, guildId);
            } catch (err) { // If non-fatal error, dashboard continues rendering
                console.error('Error fetching stats:', err);
            }
        }, 5000); // 5 seconds refresh

    } catch (err) { // If fatal error, exit process
        console.error('Failed to start dashboard:', err);
        process.exit(1);
    }
}

main(); // Start the dashboard
