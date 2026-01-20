// memoryStore.js
const { pool } = require('./db');

/**
 * Ensure a channel row exists.
 */
async function ensureChannel(channelId) {
  await pool.execute(
    `INSERT INTO channels (id)
     VALUES (?)
     ON DUPLICATE KEY UPDATE id = id`,
    [channelId]
  );
}

/**
 * Append a message to memory (user or assistant)
 * role: 'user' | 'assistant'
 * userId: Discord user ID or null for bot
 * content: string
 * timestamp: ISO string or Date (optional, defaults to now)
 */
async function addMessage(channelId, { role, userId, content, timestamp }, guildId) {
  await ensureChannel(channelId);

  const createdAt = timestamp ? new Date(timestamp) : new Date();

  await pool.execute(
    `INSERT INTO messages (channel_id, user_id, role, content, created_at, guild_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [channelId, userId || null, role, content, createdAt, guildId]
  );
}

/**
 * Get stored memory for a channel:
 * - summary (from channels.summary)
 * - last N messages (ordered oldest → newest)
 */
async function getChannelMemory(channelId, limit = 50) {
  await ensureChannel(channelId);

  const [channelRows] = await pool.execute(
    `SELECT summary
       FROM channels
      WHERE id = ?`,
    [channelId]
  );

  const summary = channelRows[0]?.summary || '';

  const [messageRows] = await pool.execute(
    `SELECT role,
            user_id   AS userId,
            content,
            created_at AS timestamp
       FROM messages
      WHERE channel_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    [channelId, limit]
  );

  // Reverse so oldest → newest
  const messages = messageRows.reverse();

  return { summary, messages };
}

/**
 * Ensure a guild row exists.
 */
async function ensureGuild(guildId) {
  await pool.execute(
    `INSERT INTO guilds (id)
     VALUES (?)
     ON DUPLICATE KEY UPDATE id = id`,
    [guildId]
  );
}

/**
 * Get stored memory for a guild:
 * - summary
 * - users (JSON string)
 */
async function getGuildMemory(guildId) {
  await ensureGuild(guildId);

  const [rows] = await pool.execute(
    `SELECT summary, users_json AS users
       FROM guilds
      WHERE id = ?`,
    [guildId]
  );

  const row = rows[0] || {};
  return { summary: row.summary || '', users: row.users || '[]' };
}

/**
 * Update or set the summary and users JSON for a guild.
 */
async function updateGuildMemory(guildId, summary, usersJson) {
  await ensureGuild(guildId);

  await pool.execute(
    `UPDATE guilds
        SET summary = ?,
            users_json = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [summary, usersJson, guildId]
  );
}

/**
 * Set a note for a user in the guild's users JSON.
 * Creates or updates a user entry with a `note` field.
 */
async function setUserNote(guildId, userId, note) {
  const guild = await getGuildMemory(guildId);
  const users = JSON.parse(guild.users || '[]');

  let user = users.find(u => String(u.id) === String(userId));
  if (!user) {
    user = { id: String(userId) };
    users.push(user);
  }

  user.note = note;

  await updateGuildMemory(guildId, guild.summary || '', JSON.stringify(users));
}

/**
 * Get the note for a user in a guild, or null if none.
 */
async function getUserNote(guildId, userId) {
  const guild = await getGuildMemory(guildId);
  const users = JSON.parse(guild.users || '[]');

  const user = users.find(u => String(u.id) === String(userId));
  return user?.note ?? null;
}

/**
 * Update or set the summary for a channel.
 */
async function updateChannelSummary(channelId, summary) {
  await ensureChannel(channelId);

  await pool.execute(
    `UPDATE channels
        SET summary = ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [summary, channelId]
  );
}

/**
 * Keep only the latest N messages in a channel, delete older ones.
 */
async function truncateOldMessages(channelId, keepLatest = 50) {
  // MySQL: delete any rows not in the set of latest `keepLatest` ids
  await pool.execute(
    `DELETE FROM messages
      WHERE channel_id = ?
        AND id NOT IN (
          SELECT id FROM (
            SELECT id
              FROM messages
             WHERE channel_id = ?
             ORDER BY created_at DESC
             LIMIT ?
          ) AS t
        )`,
    [channelId, channelId, keepLatest]
  );
}

/**
 * Get guild-wide context for AI (cross-channel awareness)
 * Returns summaries from top N active channels + trending topics
 * 
 * @param {string} guildId - Discord guild ID
 * @param {Object} options - Configuration options
 * @returns {Object} - { summaries, topics, contextString }
 */
async function getGuildWideContext(guildId, options = {}) {
  const { maxChannels = 5, timeWindowHours = 24 } = options;

  const conn = await pool.getConnection();
  try {
    // Get top N active channels by message count in the last 24h
    const [activeChannels] = await conn.query(`
      SELECT 
        m.channel_id, 
        (SELECT channel_name FROM messages WHERE channel_id = m.channel_id ORDER BY created_at DESC LIMIT 1) AS name,
        c.summary, 
        COUNT(*) as msg_count
      FROM messages m
      LEFT JOIN channels c ON m.channel_id = c.id
      WHERE m.guild_id = ? 
        AND m.created_at > NOW() - INTERVAL ? HOUR
      GROUP BY m.channel_id, c.summary
      ORDER BY msg_count DESC
      LIMIT ?
    `, [guildId, timeWindowHours, maxChannels]);

    if (activeChannels.length === 0) {
      return {
        summaries: [],
        topics: [],
        contextString: 'No recent activity in this server.'
      };
    }

    // Build summaries array
    const summaries = activeChannels.map(ch => ({
      channelId: ch.channel_id,
      name: ch.name || 'unknown',
      summary: ch.summary || 'No summary yet',
      messageCount: ch.msg_count
    }));

    // Get trending topics from emerging_topics
    const [topicsRows] = await conn.query(`
      SELECT topic, score
      FROM emerging_topics
      WHERE guild_id = ?
      ORDER BY score DESC
      LIMIT 5
    `, [guildId]);

    const topics = topicsRows.map(t => t.topic);

    // Build context string for AI consumption
    const channelSummaries = summaries
      .map(s => `#${s.name}: ${s.summary}`)
      .join('\n');

    const topicsStr = topics.length > 0
      ? `Trending: ${topics.join(', ')}`
      : '';

    const contextString = [channelSummaries, topicsStr]
      .filter(Boolean)
      .join('\n\n');

    return {
      summaries,
      topics,
      contextString
    };

  } finally {
    conn.release();
  }
}

module.exports = {
  addMessage,
  getChannelMemory,
  updateChannelSummary,
  truncateOldMessages,
  getGuildMemory,
  updateGuildMemory,
  setUserNote,
  getUserNote,
  getGuildWideContext,
};
