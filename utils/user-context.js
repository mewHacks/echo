// filepath: utils/user-context.js
// Utilities for building and managing user context information

const DEBUG_GEMINI = (() => {
  const raw = process.env.DEBUG_GEMINI ?? process.env.DEBUG_Echo ?? '';
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }
  return Boolean(raw);
})();

const debugLog = (...args) => {
  if (!DEBUG_GEMINI) return;
  console.log('[User Context DEBUG]', ...args);
};

/**
 * Build user info object with all available Discord member details
 * @param {string} userId - Discord user ID
 * @param {import('discord.js').Guild} guild - Guild object (optional for DMs)
 * @param {import('discord.js').User} fallbackUser - Fallback user object if member fetch fails
 * @param {Map<string, object>} storedGuildUserById - Map of stored guild user data
 * @returns {Promise<object>}
 */
async function buildUserInfo(userId, guild, fallbackUser, storedGuildUserById = new Map()) {
  try {
    if (!guild) {
      // DM context: no guild
      if (fallbackUser) {
        return {
          id: userId,
          username: fallbackUser.username,
          displayName: fallbackUser.displayName || fallbackUser.globalName || fallbackUser.username,
          nickname: null,
          roles: [],
          tag: fallbackUser.tag || `${fallbackUser.username}#?`,
          avatar: fallbackUser.displayAvatarURL?.({ size: 128 }) || null,
          bio: fallbackUser.bio || null,
          note: storedGuildUserById.get(String(userId))?.note ?? null,
        };
      }
      // Fallback if no user object
      return {
        id: userId,
        username: `User ${userId}`,
        displayName: `User ${userId}`,
        nickname: null,
        roles: [],
        tag: `User#${userId}`,
        avatar: null,
        bio: null,
        note: null,
      };
    }

    // Guild context: fetch member
    let member = guild.members?.cache?.get(userId) || null;
    if (!member) {
      member = await guild.members.fetch(userId);
    }

    const user = member.user;
    const username = user.username;
    const displayName = member.displayName || user.globalName || user.username;
    const nickname = member.nickname || null;
    const roles = member.roles?.cache ? member.roles.cache.map(r => r.name) : [];
    const tag = user.tag;
    const avatar = user.displayAvatarURL?.({ size: 128 }) || null;

    // Try multiple common properties where a bio/about may be stored
    let bio = null;
    try {
      bio = user.bio ?? user.profile?.bio ?? user.about ?? null;
    } catch (e) {
      bio = null;
    }

    if (DEBUG_GEMINI && bio) {
      const sample = bio.length > 200 ? bio.slice(0, 200) + '…' : bio;
      debugLog(`Fetched user ${userId} - bio present, sample: ${sample}`);
    }

    return {
      id: userId,
      username,
      displayName,
      nickname,
      roles,
      tag,
      avatar,
      bio,
      note: storedGuildUserById.get(String(userId))?.note ?? null,
    };
  } catch (e) {
    debugLog(`Failed to fetch user info for ${userId}, using fallback:`, e.message);

    // Fallback: use provided data
    if (fallbackUser) {
      return {
        id: userId,
        username: fallbackUser.username,
        displayName: fallbackUser.displayName || fallbackUser.globalName || fallbackUser.username,
        nickname: null,
        roles: [],
        tag: fallbackUser.tag || `${fallbackUser.username}#?`,
        avatar: fallbackUser.displayAvatarURL?.({ size: 128 }) || null,
        bio: fallbackUser.bio || null,
        note: storedGuildUserById.get(String(userId))?.note ?? null,
      };
    }

    // Last resort fallback
    return {
      id: userId,
      username: `User ${userId}`,
      displayName: `User ${userId}`,
      nickname: null,
      roles: [],
      tag: `User#${userId}`,
      avatar: null,
      bio: null,
      note: storedGuildUserById.get(String(userId))?.note ?? null,
    };
  }
}

/**
 * Build user info map for multiple users efficiently
 * @param {Set<string>} userIds - Set of Discord user IDs
 * @param {import('discord.js').Guild} guild - Guild object
 * @param {import('discord.js').User} senderUser - Current message sender
 * @param {object[]} guildUsers - Stored guild user data
 * @returns {Promise<Record<string, object>>}
 */
async function buildUserInfoMap(userIds, guild, senderUser, guildUsers = []) {
  const storedGuildUserById = new Map();
  for (const u of guildUsers || []) {
    if (!u || !u.id) continue;
    storedGuildUserById.set(String(u.id), u);
  }

  const userInfoMap = {};

  for (const id of userIds) {
    if (userInfoMap[id]) continue;

    const fallbackUser = id === senderUser.id ? senderUser : null;
    userInfoMap[id] = await buildUserInfo(id, guild, fallbackUser, storedGuildUserById);
  }

  // Merge stored guild users that weren't in the fetched user ids
  for (const u of guildUsers) {
    if (!u || !u.id) continue;
    if (userInfoMap[u.id]) continue;
    
    userInfoMap[u.id] = {
      id: u.id,
      username: u.username || `User ${u.id}`,
      displayName: u.displayName || u.shortName || u.username || `User ${u.id}`,
      nickname: u.nickname || null,
      roles: u.roles || [],
      tag: u.tag || null,
      avatar: u.avatar || null,
      bio: u.bio || null,
      note: u.note || null,
    };
  }

  return userInfoMap;
}

/**
 * Format speaker name for display in transcripts
 * @param {object} message - Message object with role and userId
 * @param {Record<string, object>} userInfoMap - User info map
 * @returns {string}
 */
function formatSpeaker(message, userInfoMap) {
  if (message.role === 'assistant') return 'Echo';
  const info = message.userId ? userInfoMap[message.userId] : null;
  return info?.displayName || info?.username || (message.userId ? `User ${message.userId}` : 'User');
}

/**
 * Format user info for display in prompts
 * @param {object} userInfo - User info object
 * @returns {string}
 */
function formatUserInfo(userInfo) {
  return `- ID: ${userInfo.id}, Username: ${userInfo.username}, Display name: ${userInfo.displayName}, Nickname: ${userInfo.nickname || '(none)'}, Roles: ${userInfo.roles && userInfo.roles.length ? userInfo.roles.join(', ') : '(none)'}, Bio: ${userInfo.bio || '(none)'}, Note: ${userInfo.note || '(none)'}`;
}

module.exports = {
  buildUserInfo,
  buildUserInfoMap,
  formatSpeaker,
  formatUserInfo,
};
