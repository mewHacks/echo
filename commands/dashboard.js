const { SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require('discord.js');
const { pool } = require('../db');

/**
 * Helper to determine emoji based on mood score
 * @param {number} score - Mood score (-1.0 to 1.0)
 * @returns {string} - Emoji
 */
function getMoodEmoji(score) {
    if (score >= 0.5) return '🤩'; // Very positive
    if (score >= 0.2) return '🙂'; // Positive
    if (score >= -0.2) return '😐'; // Neutral
    if (score >= -0.6) return '😟'; // Negative
    return '🤬'; // Very negative
}

/**
 * Helper to determine color based on mood score
 * @param {number} score - Mood score (-1.0 to 1.0)
 * @returns {number} - Hex color code
 */
function getMoodColor(score) {
    if (score >= 0.2) return 0x57F287; // Green
    if (score >= -0.2) return 0xFEE75C; // Yellow
    return 0xED4245; // Red
}

/**
 * Fetch dashboard data for a specific guild and combine multiple tables into one structured object
 * @param {string} guildId 
 */
async function fetchDashboardData(guildId) {

    // Initialize an empty object with default values to store the data
    const data = {
        moodScore: 0,
        moodTrend: 'stable',
        dominantSignal: 'text',
        topics: [],
        interventionCount: 0,
        stats: {
            messages: 0,
            activeUsers: 0,
            sentiment: 0
        },
        updatedAt: 'Never'
    };

    try {
        // Server state to get most recent aggregate mood and analysis
        const [stateRows] = await pool.query(
            'SELECT mood_score, mood_trend, dominant_signal, dominant_topics, updated_at FROM server_state WHERE guild_id = ?',
            [guildId]
        );

        // If we have data, overwrite defaults
        if (stateRows.length > 0) {
            const state = stateRows[0];

            data.moodScore = state.mood_score || 0;
            data.moodTrend = state.mood_trend || 'stable';
            data.dominantSignal = state.dominant_signal || 'text';

            // Topics may already be JSON-parsed or still a string
            data.topics = state.dominant_topics || [];

            // Convert timestamp to readable local time
            data.updatedAt = state.updated_at ? new Date(state.updated_at).toLocaleString() : 'Unknown';
        }

        // Daily stats (Today) to get messages, active users, and average sentiment
        const today = new Date().toISOString().split('T')[0];
        const [statsRows] = await pool.query(
            'SELECT message_count, active_users, sentiment_avg FROM daily_stats WHERE guild_id = ? AND date = ?',
            [guildId, today]
        );

        if (statsRows.length > 0) {
            data.stats.messages = statsRows[0].message_count;
            data.stats.activeUsers = statsRows[0].active_users;
            data.stats.sentiment = statsRows[0].sentiment_avg;
        }

        // Intervention Count (Today) that counts moderation or AI interventions triggered today
        const [intRows] = await pool.query(
            'SELECT COUNT(*) as count FROM intervention_history WHERE guild_id = ? AND DATE(created_at) = ?',
            [guildId, today]
        );
        data.interventionCount = intRows[0]?.count || 0;

    } catch (err) { // Error handling, dashboard sitll renders with defaults
        console.error('Error fetching dashboard data:', err);
    }

    return data;
}

module.exports = {
    // Slash command definition
    data: new SlashCommandBuilder()
        .setName('dashboard')
        .setDescription('View the intelligence dashboard for this server (Admin only)'),

    async execute(interaction) {
        // Admin permission check to prevent normal users from accessing the dashboard with sensitive analytics
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({
                content: '🔒 **Access Denied**: You must be an **Administrator** to view the intelligence dashboard.',
                ephemeral: true
            });
        }

        // Defer reply (ephemeral) to give the bot more time to query the DB
        await interaction.deferReply({ ephemeral: true });

        try {
            // Fetch data
            const guildId = interaction.guild.id;
            const data = await fetchDashboardData(guildId);

            // Build embed
            const moodEmoji = getMoodEmoji(data.moodScore);
            const moodColor = getMoodColor(data.moodScore);

            // Normalize topics (can be JSON string or array)
            let parsedTopics = data.topics;
            if (typeof parsedTopics === 'string') {
                try { parsedTopics = JSON.parse(parsedTopics); } catch (e) { parsedTopics = [parsedTopics]; }
            }
            if (!Array.isArray(parsedTopics)) parsedTopics = [];

            // Format topics for display
            const topicsStr = parsedTopics.length > 0
                ? parsedTopics.map(t => `\`${t}\``).join(', ')
                : '*No significant topics detected*';

            const embed = new EmbedBuilder()
                .setTitle(`🧠 Echo Intelligence: ${interaction.guild.name}`)
                .setDescription(`Live analysis of server atmosphere and activity.`)
                .setColor(moodColor)
                .addFields(
                    {
                        name: '🌡️ Server Mood',
                        value: `${moodEmoji} **${data.moodScore.toFixed(2)}**\nTrend: ${data.moodTrend}`,
                        inline: true
                    },
                    {
                        name: '📡 Dominant Signal',
                        value: `**${data.dominantSignal.toUpperCase()}**`,
                        inline: true
                    },
                    {
                        name: '🛡️ Interventions',
                        value: `**${data.interventionCount}** today`,
                        inline: true
                    },
                    {
                        name: '🔥 Trending Topics',
                        value: topicsStr,
                        inline: false
                    },
                    {
                        name: `📅 Activity (Today)`,
                        value: `messages: **${data.stats.messages}** | users: **${data.stats.activeUsers}**`,
                        inline: false
                    }
                )
                .setFooter({ text: `Last updated: ${data.updatedAt}` })
                .setTimestamp();

            // Send response
            await interaction.editReply({ embeds: [embed] });

        } catch (error) { // Error handling 
            console.error('Dashboard command error:', error);
            await interaction.editReply({
                content: '❌ An error occurred while generating the dashboard.'
            });
        }
    }
};
