/**
 * Registers GET /api/guilds/count, returning the number of guilds the bot is in.
 *
 * @param {import('express').Router} router
 * @param {{ client: import('discord.js').Client }} context
 */
module.exports = function registerGuildCountRoute(router, { client }) {
  router.get('/guilds/count', (req, res) => {
    const guildCount = client?.guilds?.cache?.size ?? 0;
    res.json({ guildCount });
  });
};
