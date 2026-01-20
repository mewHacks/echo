// discord-client.js
// Singleton accessor for Discord client instance
// Allows other modules (like intervention-planner) to access the client without circular imports

/** @typedef {import('discord.js').Client} Client */

// ============================================================================
// USAGE
// ============================================================================
//
// In index.js (after creating client):
//   const { setDiscordClient } = require('./discord-client');
//   setDiscordClient(client);
//
// In any other module:
//   const { getDiscordClient } = require('./discord-client');
//   const client = getDiscordClient();
//   const guild = client.guilds.cache.get(guildId);
//
// ============================================================================

/** @type {Client | null} */
let discordClient = null;

/**
 * Set the Discord client instance
 * Should be called once in index.js after client creation
 * 
 * @param {Client} client - Discord.js Client instance
 */
function setDiscordClient(client) {
    if (discordClient) {
        console.warn('[DiscordClient] Client already set, overwriting...');
    }
    discordClient = client;
    console.log('[DiscordClient] Client instance registered');
}

/**
 * Get the Discord client instance
 * Throws if client hasn't been set yet
 * 
 * @returns {Client} Discord.js Client instance
 */
function getDiscordClient() {
    if (!discordClient) {
        throw new Error('[DiscordClient] Client not set. Call setDiscordClient() first.');
    }
    return discordClient;
}

/**
 * Check if Discord client is available
 * Useful for graceful fallbacks
 * 
 * @returns {boolean} True if client is set
 */
function isClientReady() {
    return discordClient !== null && discordClient.isReady();
}

module.exports = {
    setDiscordClient,
    getDiscordClient,
    isClientReady,
};
