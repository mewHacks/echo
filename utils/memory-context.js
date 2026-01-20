// filepath: utils/memory-context.js
// Utilities for building conversation and memory context

/**
 * Build channel history context from stored messages
 * @param {object[]} messages - Array of stored messages
 * @param {Record<string, object>} userInfoMap - User info map
 * @param {function} formatSpeaker - Function to format speaker names
 * @returns {string}
 */
function buildChatHistoryText(messages, userInfoMap, formatSpeaker) {
  if (!messages || messages.length === 0) {
    return 'No stored history yet.';
  }

  const messageById = new Map();
  for (const m of messages) {
    if (m.messageId) {
      messageById.set(m.messageId, m);
    }
  }

  const historyLines = messages.map(m => {
    const speaker = formatSpeaker(m, userInfoMap);
    const ts = m.timestamp instanceof Date
      ? m.timestamp.toISOString()
      : new Date(m.timestamp).toISOString();

    let historyLine = `[${ts}] ${speaker}: ${m.content}`;

    // Add reply context if available
    if (m.replyToMessageId && messageById.has(m.replyToMessageId)) {
      const repliedMsg = messageById.get(m.replyToMessageId);
      const repliedSpeaker = formatSpeaker(repliedMsg, userInfoMap);
      const repliedContent = repliedMsg.content ? repliedMsg.content.substring(0, 100) : '(no text)';
      const truncated = repliedMsg.content && repliedMsg.content.length > 100 ? '...' : '';
      historyLine += ` [replying to ${repliedSpeaker}: "${repliedContent}${truncated}"]`;
    }

    return historyLine;
  });

  return historyLines.join('\n');
}

/**
 * Build raw channel chat from Discord API messages
 * @param {import('discord.js').Collection} rawMessages - Discord message collection
 * @param {Record<string, object>} userInfoMap - User info map
 * @param {number} maxMessages - Maximum messages to include
 * @returns {Promise<string>}
 */
async function buildLiveChatText(rawMessages, userInfoMap, maxMessages = 12) {
  if (!rawMessages || rawMessages.size === 0) {
    return 'No recent raw channel chat.';
  }

  const sorted = [...rawMessages.values()].sort(
    (a, b) => a.createdTimestamp - b.createdTimestamp
  );

  const liveChatLines = [];

  for (const m of sorted) {
    if (m.author.bot) continue;
    if (!m.content || !m.content.trim()) continue;
    if (m.content.startsWith('/')) continue;

    const ts = new Date(m.createdAt).toISOString();
    const userInfo = userInfoMap[m.author.id];
    //const displayName = userInfo?.displayName || m.author.username;
    let displayName = userInfo?.displayName || m.author.username;

    // Identity Fix: If the message is from the bot itself, force name to 'Echo'
    // This prevents the LLM from dissociating from its own messages
    if (m.author.id === m.client.user.id) {
      displayName = 'Echo';
    }

    let messageLine = `[${ts}] ${displayName}: ${m.content}`;

    // Add reply context if available
    if (m.reference && m.reference.messageId) {
      try {
        const repliedMsg = await m.channel.messages.fetch(m.reference.messageId).catch(() => null);
        if (repliedMsg && repliedMsg.author) {
          const repliedContent = repliedMsg.content ? repliedMsg.content.substring(0, 100) : '(no text)';
          const truncated = repliedMsg.content && repliedMsg.content.length > 100 ? '...' : '';
          messageLine += ` [replying to ${repliedMsg.author.username}: "${repliedContent}${truncated}"]`;
        }
      } catch (e) {
        // Silently skip if we can't fetch the replied message
      }
    }

    liveChatLines.push(messageLine);

    if (liveChatLines.length >= maxMessages) break;
  }

  return liveChatLines.length ? liveChatLines.join('\n') : 'No recent raw channel chat.';
}

/**
 * Build conversation transcript for summarization
 * @param {object[]} messages - Array of stored messages
 * @param {Record<string, object>} userInfoMap - User info map
 * @param {function} formatSpeaker - Function to format speaker names
 * @returns {string}
 */
function buildConversationForSummary(messages, userInfoMap, formatSpeaker) {
  return messages
    .map(m => {
      const speaker = formatSpeaker(m, userInfoMap);
      const ts = m.timestamp instanceof Date
        ? m.timestamp.toISOString()
        : new Date(m.timestamp).toISOString();
      return `[${ts}] ${speaker}: ${m.content}`;
    })
    .join('\n');
}

/**
 * Format known users block for Gemini context
 * @param {Record<string, object>} userInfoMap - User info map
 * @param {function} formatUserInfo - Function to format user info
 * @returns {string}
 */
function formatKnownUsersBlock(userInfoMap, formatUserInfo) {
  const knownUsersLines = Object.values(userInfoMap).map(info => formatUserInfo(info));
  return knownUsersLines.join('\n');
}

module.exports = {
  buildChatHistoryText,
  buildLiveChatText,
  buildConversationForSummary,
  formatKnownUsersBlock,
};
