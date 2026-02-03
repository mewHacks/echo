// commands/analyze.js
// Manually triggers the Intelligence Engine for the current guild.
// Useful when the server is quiet and you want to flush the buffer immediately.

const { SlashCommandBuilder, PermissionsBitField } = require('discord.js'); // For defining /analyze
const { analyzeGuild } = require('../core/analyzer'); // For running the analysis, same one used by scheduler

module.exports = {
    data: new SlashCommandBuilder()
        .setName('analyze') // Slash command name: /analyze
        .setDescription('Force-trigger the AI analysis for this server'), // Desc shown in Discord UI

    async execute(interaction) {

        // Slash commands should be guild-based, but this is a hard guard
        if (!interaction.guild) {
            return interaction.reply({
                content: 'This command can only be used inside a server.',
                ephemeral: true
            });
        }

        // Restrict /analyze to admins only
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({
                content: 'You must be an Administrator to force-trigger analysis.',
                ephemeral: true
            });
        }

        // deferReply because analysis might take > 3 seconds, tells Discord we're working on it
        await interaction.deferReply();

        try {
            const guildId = interaction.guild.id;

            // Call the core engine
            const result = await analyzeGuild(guildId, { force: true });

            // Analyzer returns null when there are no new messages
            if (!result) {
                return interaction.editReply('**No new messages to analyze.** The database is up to date.');
            }

            // Create a nice summary with limits and safety checks
            // Limits topics so that it does not exceed Discord 2000 words limit
            const topics = (result.topics || []).slice(0, 5).map(t => `\`${t.topic}\``).join(', ') || 'None';

            // toFixed() crashes if avg is not a number
            const sentimentAvg = typeof result.sentiment?.avg === 'number' ? result.sentiment.avg.toFixed(2) : '0.00';

            // Events may be undefined or malformed
            const eventsCount = Array.isArray(result.events) ? result.events.length : 0;

            // Send final response
            await interaction.editReply({
                content: `**Analysis Complete!**\n> **Topics:** ${topics}\n> **Sentiment:** ${sentimentAvg}\n> **Events:** ${eventsCount} detected.\n\n*Dashboard updated.*`
            });

        } catch (error) { // Error handling
            console.error('[Analyze Command] Failed:', error);
            await interaction.editReply('**Analysis Failed.** Check bot console for details.');
        }
    },
};
