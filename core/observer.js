// core/observer.js
// Passively listens to all messages, ignores bots and DMs, and writes immediately to database
// Tracks message creates, edits, and deletes for comprehensive context analysis

const { pool } = require('../db');
const { debugLog } = require('../utils/debugging');
const { triggerCheck } = require('./scheduler');
const { getGuildSettings } = require('./guild-settings');

/**
 * Main entry point: observe NEW message
 * @param {import('discord.js').Message} message 
 * @returns {Promise<void>}
 */
async function observe(message) {

    // Ignore bot messages to prevent feedback loops and wasted database space
    if (message.author.bot) return;

    // Ignore DMs for now, we only track server activity for privacy and prevent schema mismatches
    if (!message.guild) return;

    const settings = await getGuildSettings(message.guild.id);

    // Passive logging off: skip storing and skip nudging the scheduler
    if (!settings.passiveLogging) return;

    // Prevents empty rows for embeds/stickers/system messages
    if (!message.content || message.content.trim() === '') {
        debugLog(`[Observer] Skipping empty message from ${message.author.username}`);
        return;
    }

    // Debug timing to ensure we don't block the event loop
    const start = Date.now();

    try {
        // Prepare the SQL query 
        // Capture username and channel_name NOW to avoid API calls later during analysis
        const query = `
            INSERT INTO messages 
            (channel_id, user_id, username, channel_name, content, guild_id, role, event_type)
            VALUES (?, ?, ?, ?, ?, ?, 'user', 'create')
        `;

        // Execute the insert immediately
        // Fire and forget, await it but even if fails, don't stop bot
        /** @type {any} */
        await pool.query(query, [
            message.channel.id,
            message.author.id,
            message.author.username, // Stored for context (e.g. "Who said this?")
            // @ts-ignore - channel.name existence check
            message.channel.name || 'DM', // Stored for context (e.g. "Was this in #general or #gaming?")
            message.content,
            message.guild.id
        ]);

        debugLog(`[Observer] Saved message from ${message.author.username} in ${Date.now() - start}ms`);

        // Trigger immediate analysis check (real-time responsiveness)
        // Only do this when background analysis is enabled
        if (settings.backgroundAnalysis) {
            triggerCheck(message.guild.id);
        }



    } catch (err) { // Log error but don't crash
        console.error(`[Observer] Failed to save message:`, err);
    }
}

/**
 * Observe message EDIT
 * Tracks both old and new content for context (e.g., detecting backpedaling)
 * @param {import('discord.js').Message} oldMessage - Message before edit (may be partial)
 * @param {import('discord.js').Message} newMessage - Message after edit
 * @returns {Promise<void>}
 */
async function observeEdit(oldMessage, newMessage) {
    // Ignore bots
    if (newMessage.author?.bot) return;

    // Ignore DMs
    if (!newMessage.guild) return;

    // Skip if content unchanged (could be embed update)
    if (oldMessage.content === newMessage.content) return;

    // Skip empty messages
    if (!newMessage.content || newMessage.content.trim() === '') return;

    const start = Date.now();

    try {
        const query = `
            INSERT INTO messages 
            (channel_id, user_id, username, channel_name, content, guild_id, role, event_type, previous_content)
            VALUES (?, ?, ?, ?, ?, ?, 'user', 'edit', ?)
        `;

        /** @type {any} */
        await pool.query(query, [
            newMessage.channel.id,
            newMessage.author?.id || 'unknown',
            newMessage.author?.username || 'unknown',
            // @ts-ignore
            newMessage.channel.name || 'DM',
            newMessage.content, // New content
            newMessage.guild.id,
            oldMessage.content || null // Old content (may be null if message was partial/uncached)
        ]);

        console.log(`[Observer] Tracked edit from ${newMessage.author?.username || 'unknown'} in ${Date.now() - start}ms`);

    } catch (err) {
        console.error(`[Observer] Failed to track edit:`, err);
    }
}

/**
 * Observe message DELETE
 * Records that a message was deleted (content may be unavailable if uncached)
 * @param {import('discord.js').Message} message - Deleted message (may be partial)
 * @returns {Promise<void>}
 */
async function observeDelete(message) {
    // Ignore bots
    if (message.author?.bot) return;

    // Ignore DMs
    if (!message.guild) return;

    const start = Date.now();

    try {
        const query = `
            INSERT INTO messages 
            (channel_id, user_id, username, channel_name, content, guild_id, role, event_type)
            VALUES (?, ?, ?, ?, ?, ?, 'user', 'delete')
        `;

        /** @type {any} */
        await pool.query(query, [
            message.channel?.id || 'unknown',
            message.author?.id || 'unknown',
            message.author?.username || 'unknown',
            // @ts-ignore
            message.channel?.name || 'unknown',
            message.content || '[content unavailable - message was not cached]',
            message.guild?.id || 'unknown'
        ]);

        console.log(`[Observer] Tracked delete from ${message.author?.username || 'unknown'} in ${Date.now() - start}ms`);

    } catch (err) {
        console.error(`[Observer] Failed to track delete:`, err);
    }
}

module.exports = {
    observe,
    observeEdit,
    observeDelete,
};
