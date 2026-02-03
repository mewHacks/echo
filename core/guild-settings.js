// core/guild-settings.js
// Centralized helper for per-guild feature toggles

const { pool } = require('../db');
const { debugLog } = require('../utils/debugging');

const CACHE_TTL_MS = 30_000;
const settingsCache = new Map();

const DEFAULT_SETTINGS = Object.freeze({
  passiveLogging: true,
  backgroundAnalysis: true,
  adminDm: false,
  channelMessage: true
});

/**
 * Normalize database row to settings object.
 * @param {any} row
 */
function normalizeRow(row) {
  const r = row || {};
  return {
    passiveLogging: r.passive_logging !== 0,
    backgroundAnalysis: r.background_analysis !== 0,
    adminDm: r.admin_dm !== 0,
    channelMessage: r.channel_message !== 0
  };
}

/**
 * Get settings for a guild with short-term caching.
 * @param {string} guildId
 */
async function getGuildSettings(guildId) {
  const cached = settingsCache.get(guildId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.settings;
  }

  try {
    const [rows] = /** @type {[any[], any]} */ (await pool.query(
      'SELECT passive_logging, background_analysis, admin_dm, channel_message FROM guild_settings WHERE guild_id = ?',
      [guildId]
    ));

    const settings = rows.length ? normalizeRow(rows[0]) : Object.assign({}, DEFAULT_SETTINGS);
    settingsCache.set(guildId, { settings, timestamp: Date.now() });
    return settings;
  } catch (err) {
    console.error('[GuildSettings] Failed to load settings:', /** @type {Error} */ (err).message);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Update settings for a guild (UPSERT) and refresh cache.
 * @param {string} guildId
 * @param {Partial<typeof DEFAULT_SETTINGS>} updates
 */
async function updateGuildSettings(guildId, updates) {
  const current = await getGuildSettings(guildId);
  const next = Object.assign({}, current, updates);

  try {
    await pool.query(
      `INSERT INTO guild_settings (guild_id, passive_logging, background_analysis, admin_dm, channel_message)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         passive_logging = VALUES(passive_logging),
         background_analysis = VALUES(background_analysis),
         admin_dm = VALUES(admin_dm),
         channel_message = VALUES(channel_message)`,
      [
        guildId,
        next.passiveLogging ? 1 : 0,
        next.backgroundAnalysis ? 1 : 0,
        next.adminDm ? 1 : 0,
        next.channelMessage ? 1 : 0,
      ]
    );

    settingsCache.set(guildId, { settings: next, timestamp: Date.now() });
    debugLog('[GuildSettings] Updated settings for guild', guildId, next);
    return next;
  } catch (err) {
    console.error('[GuildSettings] Failed to update settings:', /** @type {Error} */ (err).message);
    return current;
  }
}

/**
 * Clear cached settings for a guild.
 * @param {string} guildId
 */
function clearGuildSettingsCache(guildId) {
  settingsCache.delete(guildId);
}

module.exports = {
  getGuildSettings,
  updateGuildSettings,
  clearGuildSettingsCache,
  DEFAULT_SETTINGS,
};
