// scripts/dashboard.js
// Live CLI Dashboard for echo intelligence
// Run in another terminal: node scripts/dashboard.js 

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

// Fetch data from DB
/**
 * @returns {Promise<DashboardData>}
 */
async function fetchStats() {

    // Get a DB connection from the pool
    const conn = await pool.getConnection();
    try {

        // Compute today's date (used for daily_stats lookup)
        const today = new Date().toISOString().slice(0, 10);

        // Daily stats that shows high-level health metrics for today (messages, users, sentiment)
        /** @type {any[]} */
        const [stats] = await conn.query(
            'SELECT * FROM daily_stats WHERE date = ? ORDER BY message_count DESC LIMIT 1',
            [today]
        );

        // Emerging topics (top 5) that shows what is the server is talking about rn with decay score
        /** @type {any[]} */
        const [topics] = await conn.query(
            'SELECT topic, score FROM emerging_topics ORDER BY score DESC LIMIT 5'
        );

        // Recent observations that shows discrete AI-detected events (conflicts, spikes, anomalies)
        /** @type {any[]} */
        const [obs] = await conn.query(
            'SELECT type, data, confidence, created_at FROM observations ORDER BY created_at DESC LIMIT 5'
        );

        // Server states (mood/trend per guild)
        /** @type {any[]} */
        const [serverStates] = await conn.query(
            'SELECT guild_id, mood_score, mood_trend, dominant_signal, updated_at FROM server_state ORDER BY updated_at DESC LIMIT 3'
        );

        // Recent interventions (decisions + reasoning)
        /** @type {any[]} */
        const [interventions] = await conn.query(
            'SELECT trigger_type, action_taken, reasoning, confidence, created_at FROM intervention_history ORDER BY created_at DESC LIMIT 5'
        );

        // Return normalized dashboard payload
        return {
            stats: stats[0] || {}, // daily_stats is single-row per day
            topics,
            obs,
            serverStates,
            interventions
        };
    } finally {
        // Always release connection back to pool
        conn.release();
    }
}

// Render the dashboard to terminal
function render(data) {

    // Clear screen and reset cursor to top-left
    process.stdout.write('\x1b[2J\x1b[0f');

    // Destructure data (including new fields)
    const { stats, topics, obs, serverStates, interventions } = data;

    // Current time shown in header
    const now = new Date().toLocaleTimeString();

    // Header UI
    console.log(`${C.BRIGHT}${C.CYAN}╔════════════════════════════════════════════════════════╗`);
    console.log(`║               ECHO INTELLIGENCE DASHBOARD              ║`);
    console.log(`║                  ${C.DIM}${now.padEnd(38)}${C.CYAN}║`);
    console.log(`╚════════════════════════════════════════════════════════╝${C.RESET}\n`);

    // ═══════════════════════════════════════════════════════════════════════
    // Server States Section
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`${C.BRIGHT}🧠 SERVER STATES${C.RESET}`);
    console.log(`----------------------------------------------------------`);
    if (!serverStates || serverStates.length === 0) {
        console.log(`${C.DIM}(No server states yet)${C.RESET}`);
    } else {
        serverStates.forEach(s => {
            const moodScore = s.mood_score || 0;
            const moodColor = moodScore > 0.2 ? C.GREEN : moodScore < -0.2 ? C.RED : C.YELLOW;
            const guildShort = s.guild_id.slice(-6); // Last 6 chars of guild ID
            const trend = s.mood_trend || 'stable';
            const signal = s.dominant_signal || 'text';
            console.log(`Guild ...${guildShort} | Mood: ${moodColor}${moodScore.toFixed(2)}${C.RESET} (${trend}) | Signal: ${signal}`);
        });
    }
    console.log('');

    // ═══════════════════════════════════════════════════════════════════════
    // Intervention Log Section
    // ═══════════════════════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════════════════════
    // Today's Pulse
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`${C.BRIGHT}📊 TODAY'S PULSE${C.RESET}`);
    console.log(`----------------------------------------------------------`);
    console.log(`Messages  : ${stats.message_count || 0}`);
    console.log(`Users     : ${stats.active_users || 0}`);

    const sentAvg = stats.sentiment_avg || 0;
    const sentColor = sentAvg > 0.2 ? C.GREEN : sentAvg < -0.2 ? C.RED : C.YELLOW;
    console.log(`Sentiment : ${sentColor}${sentAvg.toFixed(2)}${C.RESET} (Min: ${stats.sentiment_min?.toFixed(2) || 0})`);

    const negColor = (stats.negative_ratio || 0) > 0.2 ? C.RED : C.GREEN;
    console.log(`Neg Ratio : ${negColor}${((stats.negative_ratio || 0) * 100).toFixed(1)}%${C.RESET}`);
    console.log('');

    // ═══════════════════════════════════════════════════════════════════════
    // Trending Topics
    // ═══════════════════════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════════════════════
    // Recent Observations
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`${C.BRIGHT}👁🗨 RECENT OBSERVATIONS${C.RESET}`);
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

// Main loop
async function main() {
    console.log('Connecting to database...');
    try {
        // Initial fetch immediately on startup
        const data = await fetchStats();
        render(data);

        // Refresh dashboard every 5 secs
        setInterval(async () => {
            try {
                const data = await fetchStats();
                render(data);
            } catch (err) { // If non-fatal error, dashboard continues running
                console.error('Error fetching stats:', err);
            }
        }, 5000); // 5 seconds refresh

    } catch (err) { // If fatal error, exit process
        console.error('Failed to start dashboard:', err);
        process.exit(1);
    }
}

main(); // Start the dashboard
