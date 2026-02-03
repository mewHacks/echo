// scripts/verify-settings-state.js
// Usage: node scripts/verify-settings-state.js <guildId>

require('dotenv').config();
const { getGuildSettings } = require('../core/guild-settings');
const { getServerState } = require('../core/server-state');
const { pool } = require('../db');

const guildId = process.argv[2];

if (!guildId) {
    console.error('Usage: node scripts/verify-settings-state.js <guildId>');
    process.exit(1);
}

async function verify() {
    try {
        console.log(`\n🔍 Verifying Settings & State for Guild: ${guildId}\n`);

        // 1. Check Guild Settings
        console.log('--- ⚙️ Guild Settings ---');
        const settings = await getGuildSettings(guildId);
        console.table(settings);

        // 2. Check Server State
        console.log('\n--- 🧠 Server State ---');
        const state = await getServerState(guildId);

        // Print state
        console.log(`Mood Score:      ${state.moodScore.toFixed(2)}`);
        console.log(`Mood Trend:      ${state.moodTrend}`);
        console.log(`Dominant Signal: ${state.dominantSignal}`);
        console.log(`Source:          ${state.source}`);
        console.log(`Confidence:      ${state.confidence.toFixed(2)}`);
        console.log(`Last Voice:      ${state.lastVoiceSummary || '(none)'}`);
        console.log(`Dominant Topics: ${state.dominantTopics.join(', ') || '(none)'}`);

        if (state.contextMarkers && state.contextMarkers.length > 0) {
            console.log('\nContext Markers:');
            console.table(state.contextMarkers.map(m => ({
                type: m.type,
                conf: m.confidence,
                expires: m.expiresAt ? new Date(m.expiresAt).toLocaleTimeString() : 'Never'
            })));
        } else {
            console.log('Context Markers: (none)');
        }

    } catch (err) {
        console.error('Error verifying state:', err);
    } finally {
        await pool.end();
    }
}

verify();
