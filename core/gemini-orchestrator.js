// filepath: core/gemini-orchestrator.js
// Main orchestration logic for Gemini interactions
// This replaces the monolithic gemini-text.js with focused, testable modules

const { getGeminiClient } = require('../gemini-client');
const {
  addMessage,
  getChannelMemory,
  updateChannelSummary,
  truncateOldMessages,
  updateGuildMemory,
  getGuildMemory,
} = require('../memoryStore');
const { getServerState } = require('./server-state');
const { executeFunctionCall } = require('../command-handler');
const { functionPermissions, searchTool, adminTools, memoryTools } = require('../admin-tool');
const { BASE_SYSTEM_PROMPT, TEXT_MODE_CONTEXT } = require('../config/prompts');
const { GEMINI_TEXT_MODEL, GEMINI_TOOL_MODEL } = require('../config/models');
const { detectIntent } = require('./intent-router');
const { buildUserInfoMap, formatSpeaker, formatUserInfo } = require('../utils/user-context');
const {
  buildChatHistoryText,
  buildLiveChatText,
  buildConversationForSummary,
  formatKnownUsersBlock,
} = require('../utils/memory-context');
const { processAttachments } = require('../utils/attachments');
const { debugLog, startTimer, logTimingSummary } = require('../utils/debugging');
const { showConfirmationDialog, clearConfirmationUI } = require('../handlers/confirmation-ui');

/**
 * Helper to retry operations with exponential backoff
 * specifically for handling Gemini 503 Overloaded errors
 * @param {Function} operation - Async function to retry
 * @param {number} maxRetries - Max attempts (default 3)
 */
async function withRetry(operation, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      // Retry on 503 (Overloaded) or 500 (Internal Error) or 429 (Too Many Requests - sometimes transient)
      if (err.status === 503 || err.code === 503 || err.status === 500 || err.code === 500) {
        const delay = Math.pow(2, i) * 1000 + (Math.random() * 500);
        debugLog(`[Gemini] API Error ${err.status || err.code}. Retrying in ${Math.round(delay)}ms... (Attempt ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err; // Re-throw other errors immediately
    }
  }
  throw lastError;
}

// Constants
const MAX_CONTEXT_MESSAGES = 100;
const SUMMARIZE_THRESHOLD = 50;
const GUILD_MEMORY_CACHE_TTL_MS = 60_000;

const guildMemoryCache = new Map();

const getCachedGuildMemory = (guildId) => {
  const cached = guildMemoryCache.get(guildId);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > GUILD_MEMORY_CACHE_TTL_MS) {
    guildMemoryCache.delete(guildId);
    return null;
  }
  return cached.payload;
};

const setCachedGuildMemory = (guildId, payload) => {
  guildMemoryCache.set(guildId, {
    payload,
    timestamp: Date.now(),
  });
};

/**
 * Determines if we should provide context for an action
 * Only provide context when AI can't identify users/roles (invalid IDs or names used)
 */
function shouldProvideContext(actionName, args) {
  // Check for user-related parameters
  if (args.userId) {
    const userId = String(args.userId).replace(/[<@!>]/g, '');
    // If userId doesn't look like a Discord snowflake (17-19 digits), we need context
    if (!/^\d{17,19}$/.test(userId)) {
      debugLog(`Context needed: userId "${args.userId}" is not a valid ID`);
      return true;
    }
  }

  // Check for role-related parameters
  if (args.roleId) {
    const roleId = String(args.roleId).replace(/[<@&>]/g, '');
    // If roleId doesn't look like a Discord snowflake, we need context
    if (!/^\d{17,19}$/.test(roleId)) {
      debugLog(`Context needed: roleId "${args.roleId}" is not a valid ID`);
      return true;
    }
  }

  // For create_role, always provide context to avoid duplicate names
  if (actionName === 'create_role') {
    debugLog(`Context needed: create_role always gets role list`);
    return true;
  }

  // Force context for moderation actions to ensure correct ID lookup
  // Prevents hallucinations for users who aren't in the active chat context
  const forceContextActions = ['timeout_member', 'kick_member', 'ban_member'];
  if (forceContextActions.includes(actionName)) {
    debugLog(`Context needed: ${actionName} requires member list for ID verification`);
    return true;
  }

  return false;
}

/**
 * @typedef {Object} GeminiCoreOptions
 * @property {import('discord.js').TextChannel | import('discord.js').DMChannel} channel - The channel the message was sent in
 * @property {import('discord.js').Guild} [guild] - The guild (if any)
 * @property {import('discord.js').User} senderUser - The user who sent the message
 * @property {string} promptText - The text content of the message
 * @property {Array} [attachments] - Attachments
 * @property {import('discord.js').Message} [repliedMessage] - The message being replied to
 * @property {function(string): Promise<import('discord.js').Message>} reply - Function to send a reply
 */

/**
 * Main Gemini orchestration function
 * Handles context building, intent detection, Gemini API calls, and action execution
 * @param {GeminiCoreOptions} options
 */
async function runGeminiCore({
  channel,
  guild,
  senderUser,
  promptText,
  attachments = [],
  repliedMessage = null,
  reply,
}) {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    await reply('❌ GEMINI_API_KEY is not set in `.env`');
    return;
  }

  const channelId = channel.id;
  const timings = [];
  const stopTotalTimer = startTimer('Total run', timings);

  debugLog('\n\n\nStarting Gemini orchestration', {
    channelId,
    guildId: guild?.id || 'DM',
    senderId: senderUser.id,
  });

  const ai = getGeminiClient();
  const now = new Date().toISOString();

  try {
    // Store user message
    const stopStoreUserMessage = startTimer('Store user message', timings);
    try {
      await addMessage(channelId, {
        role: 'user',
        userId: senderUser.id,
        content: promptText,
        timestamp: now,
      }, guild ? guild.id : null);
    } finally {
      stopStoreUserMessage();
    }

    // Fetch stored memory
    const fetchLimit = SUMMARIZE_THRESHOLD + MAX_CONTEXT_MESSAGES;
    let summary = '';
    let messages = [];
    const stopFetchMemory = startTimer('Fetch channel memory', timings);
    try {
      const memoryPayload = await getChannelMemory(channelId, fetchLimit);
      summary = memoryPayload.summary;
      messages = memoryPayload.messages;
    } finally {
      stopFetchMemory();
    }

    // Dynamic context scaling
    const baseStoredMessages = promptText.length > 500 ? 50 : promptText.length > 200 ? 30 : 15;
    const recentStoredMessages =
      messages.length > baseStoredMessages
        ? messages.slice(-baseStoredMessages)
        : messages;

    // Fetch raw channel chat
    let liveChatText = 'No recent raw channel chat.';
    const liveUserIds = new Set();
    const stopFetchLiveChat = startTimer('Fetch recent channel chat', timings);
    try {
      const liveFetchLimit = promptText.length > 500 ? 30 : promptText.length > 200 ? 20 : 12;
      const rawMessages = await channel.messages.fetch({ limit: liveFetchLimit });
      liveChatText = await buildLiveChatText(rawMessages, {}, liveFetchLimit);

      for (const m of rawMessages.values()) {
        if (!m.author.bot) liveUserIds.add(m.author.id);
      }
    } catch (e) {
      console.error('Failed to fetch recent channel messages:', e);
    } finally {
      stopFetchLiveChat();
    }

    // Build user ID set
    const recentStoredUserIds = new Set(
      recentStoredMessages.filter(m => m.userId).map(m => m.userId)
    );
    const allUserIds = new Set([
      ...recentStoredUserIds,
      ...liveUserIds,
      senderUser.id,
    ]);

    // Fetch guild memory
    let guildMemory = { summary: '', users: '[]' };
    let guildUsers = [];
    if (guild) {
      const cachedGuild = getCachedGuildMemory(guild.id);
      if (cachedGuild) {
        guildMemory = cachedGuild;
        debugLog('Using cached guild memory');
      } else {
        const stopFetchGuildMemory = startTimer('Fetch guild memory', timings);
        try {
          guildMemory = await getGuildMemory(guild.id);
          setCachedGuildMemory(guild.id, guildMemory);
        } finally {
          stopFetchGuildMemory();
        }
      }
      try {
        guildUsers = JSON.parse(guildMemory.users || '[]');
      } catch (e) {
        guildUsers = [];
      }
    }

    // Build user info map
    const stopBuildUserInfoMap = startTimer('Build user info map', timings);
    const userInfoMap = await buildUserInfoMap(allUserIds, guild, senderUser, guildUsers);
    stopBuildUserInfoMap();

    // Fetch raw channel chat with user info
    const stopFetchLiveChatWithContext = startTimer('Build live chat context', timings);
    try {
      const liveFetchLimit = promptText.length > 500 ? 30 : promptText.length > 200 ? 20 : 12;
      const rawMessages = await channel.messages.fetch({ limit: liveFetchLimit });
      liveChatText = await buildLiveChatText(rawMessages, userInfoMap, liveFetchLimit);
    } finally {
      stopFetchLiveChatWithContext();
    }

    // Build conversation for summarization
    const conversationForSummary = buildConversationForSummary(
      messages,
      userInfoMap,
      formatSpeaker
    );

    // Build context parts
    const stopBuildParts = startTimer('Assemble Gemini request parts', timings);

    // Fetch server state for voice/mood context
    let serverStateContext = '';
    if (guild) {
      try {
        const state = await getServerState(guild.id);
        console.log('[DEBUG] GeminiOrchestrator fetched state:', {
          lastVoiceSummary: state?.lastVoiceSummary,
          lastVoiceTimestamp: state?.lastVoiceTimestamp,
          now: new Date().toISOString()
        });

        if (state && state.lastVoiceSummary) {
          // Check if voice summary is fresh enough (< 4 hours)
          const voiceTime = state.lastVoiceTimestamp ? new Date(state.lastVoiceTimestamp) : new Date(0);
          const hoursAgo = (Date.now() - voiceTime.getTime()) / (1000 * 60 * 60);

          console.log(`[DEBUG] Voice Context Age: ${hoursAgo.toFixed(2)} hours`);

          if (hoursAgo < 4) {
            serverStateContext = `\nRECENT VOICE ACTIVITY (${hoursAgo.toFixed(1)}h ago):\n"${state.lastVoiceSummary}"\n(This happened in a voice channel. If the user asks about recent discussions, use this context.)\n`;
          } else {
            console.log('[DEBUG] Voice context expired (> 4 hours)');
          }
        }
      } catch (err) {
        console.error('Failed to fetch server state for context:', err);
      }
    }

    const channelSummaryText = summary || '';
    const chatHistoryText = buildChatHistoryText(recentStoredMessages, userInfoMap, formatSpeaker);
    const knownUsersText = formatKnownUsersBlock(userInfoMap, formatUserInfo);
    const guildMemoryText = guild && guildMemory.summary ? guildMemory.summary : '';

    const selfInfo = userInfoMap[senderUser.id];
    const userInfo = `
- Username: ${selfInfo.username}
- Display name: ${selfInfo.displayName}
- Server nickname: ${selfInfo.nickname || '(none set)'}
- ID: ${selfInfo.id}
- Server: ${guild ? `${guild.name} (${guild.id})` : 'DM'}
`.trim();

    // Build chat parts (with full context)
    // Build chat parts (with full context)
    const chatParts = [
      { text: `Current sender info:\n${userInfo}` },
      { text: `Known Discord users:\n${knownUsersText}` },
      ...(guildMemoryText ? [{ text: `Stored guild memory:\n${guildMemoryText}` }] : []),
      ...(serverStateContext ? [{ text: `Server State (Voice Context):\n${serverStateContext}` }] : []),
      ...(channelSummaryText ? [{ text: `Stored channel summary:\n${channelSummaryText}` }] : []),
      { text: `Stored chat history:\n${chatHistoryText}` },
      { text: `Recent raw channel chat:\n${liveChatText}` },
    ];

    // Add replied message context
    if (repliedMessage && repliedMessage.author) {
      const repliedAuthor = userInfoMap[repliedMessage.author.id]?.displayName || repliedMessage.author.username;
      let repliedContext = `${repliedAuthor}: "${repliedMessage.content || '(no text)'}"`;
      if (repliedMessage.attachments?.size > 0) {
        const attachmentNames = [...repliedMessage.attachments.values()]
          .map(att => att.name || 'attachment')
          .join(', ');
        repliedContext += `\n(Attachments: ${attachmentNames})`;
      }
      chatParts.push({ text: `User is replying to:\n${repliedContext}` });
    }

    // Process attachments
    const stopProcessAttachments = startTimer('Process attachments', timings);
    const attachmentParts = await processAttachments(attachments);
    stopProcessAttachments();

    chatParts.push({
      text: `Current user query:\n${promptText}`,
    });
    chatParts.push(...attachmentParts);

    // Minimal action parts
    const actionParts = [
      { text: `Current sender info:\n${userInfo}` },
      { text: `User request:\n${promptText}` },
    ];
    if (repliedMessage?.author) {
      const repliedAuthor = userInfoMap[repliedMessage.author.id]?.displayName || repliedMessage.author.username;
      actionParts.push({
        text: `Reply context:\n${repliedAuthor}: "${repliedMessage.content || '(no text)'}"`,
      });
    }

    stopBuildParts();

    // Intent detection
    const intent = await detectIntent(promptText);
    debugLog('Detected intent:', intent);

    const chatSystemInstruction = `${BASE_SYSTEM_PROMPT}\n\n${TEXT_MODE_CONTEXT}\n\nIMPORTANT: For queries about current events, prices, news, weather, sports, or any time-sensitive information, use the web_search tool to get the latest information. Always search when the user asks about "now", "today", "current", "latest", or "recent".`;
    const actionSystemInstruction = BASE_SYSTEM_PROMPT;

    // Call Gemini and handle response
    let text = '';
    let discordMessage = await reply("<a:loading:1458495883657220137>");
    const stopGeminiCall = startTimer('Gemini generateContent', timings);

    const isActionFlow = intent === 'action';

    try {

      // Select appropriate context (Chat = Rich, Action = Focused)
      const initialParts = isActionFlow ? actionParts : chatParts;
      const systemInstruction = isActionFlow ? actionSystemInstruction : chatSystemInstruction;

      // Dynamic tool selection
      // - Action flow: adminTools + memoryTools
      // - Chat flow: searchTool + memoryTools
      /** @type {any[]} */
      let tools = isActionFlow ? adminTools : searchTool;
      tools = [...tools, ...memoryTools];

      // Manual tool polyfill logic for Gemini 3
      const isManualToolMode = GEMINI_TOOL_MODEL.includes('gemini-3');
      let baseConfig = { systemInstruction, tools };

      if (isManualToolMode) {
        debugLog('Using manual tool polyfill for Gemini 3');
        baseConfig.tools = undefined;
        // Build tool descriptions
        const toolDescriptions = tools.flatMap(t =>
          // @ts-ignore - functionDeclarations existence check
          (t.functionDeclarations ? t.functionDeclarations : [])
        ).filter(Boolean).map(fn => {
          const params = Object.entries(fn.parameters?.properties || {})
            .map(([key, prop]) => `   - ${key} (${prop.type}): ${prop.description}`)
            .join('\n');
          return `TOOL: ${fn.name}\nDESC: ${fn.description}\nPARAMS:\n${params}`;
        }).join('\n\n');

        baseConfig.systemInstruction += `\n\n====== TOOL USE INSTRUCTIONS ======\nYou have access to the following tools. To use one, you MUST output ONLY valid JSON in this exact format:\n{ "functionCall": { "name": "tool_name", "args": { "param": "value" } } }\n\nAVAILABLE TOOLS:\n${toolDescriptions}\n\nIMPORTANT:\n- If you need to use a tool, output ONLY the JSON. Do not output any explanation text.\n- If you do NOT need a tool, just answer normally.\n===================================\n`;
      }

      // WRAPPER: Handles both native and manual tool calls
      const generate = async (contents) => {
        const result = await withRetry(() => ai.models.generateContent({
          model: GEMINI_TOOL_MODEL,
          contents,
          config: baseConfig
        }));

        if (isManualToolMode) {
          try {
            const text = result.candidates[0].content.parts[0].text;
            // Look for JSON block
            const jsonMatch = text.match(/\{[\s\S]*"functionCall"[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (parsed.functionCall) {
                // Polyfill: inject into candidate
                result.candidates[0].content.parts = [{
                  functionCall: parsed.functionCall
                }];
              }
            }
          } catch (e) {
            // Ignore parse errors, treat as text
          }
        }
        return result;
      };

      // Initial call
      const result = await generate([{ role: 'user', parts: initialParts }]);

      const candidate = result.candidates[0];
      let currentCandidate = candidate;
      let conversationHistory = [
        { role: 'user', parts: initialParts },
        currentCandidate.content,
      ];
      let functionCalls = [];
      let functionCallCount = 0;
      const MAX_FUNCTION_CALLS = 5;

      // Multi-turn function calling loop
      while (functionCallCount < MAX_FUNCTION_CALLS) {
        const functionCallPart = currentCandidate?.content?.parts?.find(p => p.functionCall);
        if (!functionCallPart) {
          // No more function calls, model is ready to respond with text
          break;
        }

        functionCallCount++;
        let { name, args } = functionCallPart.functionCall;
        let requiredPerm = functionPermissions?.[name];

        debugLog(`Function call ${functionCallCount}: ${name}`, args);

        // Check if we need to provide context (only when AI can't identify users/roles)
        const { actionsConfig } = require('../actions-config');
        const actionConfig = actionsConfig[name];
        const needsContext = actionConfig?.buildContext && shouldProvideContext(name, args);

        if (needsContext) {
          try {
            const additionalContext = await actionConfig.buildContext({
              guild,
              user: senderUser,
              channel,
              args
            });

            if (additionalContext) {
              const contextContent = {
                role: 'user',
                parts: [{ text: `CONTEXT FOR TOOL EXECUTION:\n${additionalContext}` }]
              };
              conversationHistory.push(contextContent);

              const nextResult = await generate(conversationHistory);
              const contextCandidate = nextResult.candidates[0];

              conversationHistory.push(contextCandidate.content);

              // Update currentCandidate ONLY if there's text (meaning bot changed mind or asked Q)
              // If it called function again, we loop
              const hasText = contextCandidate?.content?.parts?.some(p => p.text);
              if (hasText) {
                currentCandidate = contextCandidate;
              } else {
                // It returned a function call again
                currentCandidate = contextCandidate;
              }
            }
          } catch (err) {
            debugLog(`Failed to build context for ${name}:`, err.message);
          }
        }

        // Check permissions first
        if (requiredPerm) {
          const member = await guild.members.fetch(senderUser.id).catch(() => null);
          const hasPermission = member?.permissions?.has(requiredPerm);

          if (!hasPermission) {
            // Permission denied
            const deniedMsg = `ERROR: The user invoking this command (ID: ${senderUser.id}) does not have the '${requiredPerm}' permission.`;

            if (isManualToolMode) {
              conversationHistory.push({
                role: 'user',
                parts: [{ text: `TOOL EXECUTION RESULT for ${name}:\n${deniedMsg}` }]
              });
            } else {
              conversationHistory.push({
                role: 'function',
                parts: [{
                  functionResponse: {
                    name,
                    response: { content: deniedMsg }
                  }
                }]
              });
            }

            // Ask Gemini to respond about the permission denial
            const nextResult = await generate(conversationHistory);

            currentCandidate = nextResult.candidates[0];
            conversationHistory.push(currentCandidate.content);
            continue;
          }
        }

        // Need confirmation if permission is required
        if (requiredPerm) {
          const actionName = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          const confirmationText = `I need confirmation to ${actionName.toLowerCase()}.`;
          debugLog(`Showing confirmation dialog for: ${actionName}`);

          const dialogResult = await showConfirmationDialog({
            actionName,
            requiredPerm,
            args,
            initialText: confirmationText,
            discordMessage,
            // @ts-ignore - property name check mismatch
            senderUserId: senderUser.id,
            guild,
          });

          if (!dialogResult.confirmed) {
            // User cancelled
            let responseContent = dialogResult.reason === 'timeout' ? 'Confirmation timed out.' : 'User cancelled this action.';

            if (isManualToolMode) {
              conversationHistory.push({
                role: 'user',
                parts: [{ text: `TOOL EXECUTION RESULT for ${name}:\n${responseContent}` }]
              });
            } else {
              conversationHistory.push({
                role: 'function',
                parts: [{
                  functionResponse: {
                    name,
                    response: { content: responseContent }
                  }
                }]
              });
            }

            // Ask Gemini to respond
            const nextResult = await generate(conversationHistory);

            currentCandidate = nextResult.candidates[0];
            conversationHistory.push(currentCandidate.content);
            continue;
          }
        }

        // Execute the function
        try {
          const member = await guild.members.fetch(senderUser.id).catch(() => null);
          let functionResult;

          // Check if it's a memory tool vs standard action
          const { executeMemoryTool } = require('./memory-tools');
          const isMemoryTool = ['search_channel_history', 'get_channel_summary', 'get_server_state'].includes(name);

          if (isMemoryTool) {
            functionResult = await executeMemoryTool(name, guild.id, args);
          } else {
            // It's a standard admin/moderation action
            functionResult = await executeFunctionCall(name, args, { channel, guild, member });
          }

          debugLog(`Function result for ${name}:`, functionResult);

          // Add function result to conversation
          const resultStr = JSON.stringify(functionResult);

          if (isManualToolMode) {
            conversationHistory.push({
              role: 'user',
              parts: [{ text: `TOOL EXECUTION RESULT for ${name}:\n${resultStr}` }]
            });
          } else {
            conversationHistory.push({
              role: 'function',
              parts: [{
                functionResponse: {
                  name,
                  response: { content: resultStr }
                }
              }]
            });
          }

          // Get next response from Gemini
          const nextResult = await generate(conversationHistory);

          currentCandidate = nextResult.candidates[0];
          conversationHistory.push(currentCandidate.content);

          functionCalls.push({ name, args, result: functionResult });
        } catch (err) {
          debugLog(`Error executing ${name}:`, err.message);

          if (isManualToolMode) {
            conversationHistory.push({
              role: 'user',
              parts: [{ text: `TOOL EXECUTION ERROR for ${name}:\n${err.message}` }]
            });
          } else {
            conversationHistory.push({
              role: 'function',
              parts: [{
                functionResponse: {
                  name,
                  response: { content: `Error executing tool: ${err.message}` }
                }
              }]
            });
          }

          // Get next response from Gemini
          const nextResult = await generate(conversationHistory);

          currentCandidate = nextResult.candidates[0];
          conversationHistory.push(currentCandidate.content);
        }
      }

      // Extract final text response
      const finalTextContent = currentCandidate?.content?.parts?.find(p => p.text)?.text;

      // Handle response - use the text we already have from currentCandidate
      if (finalTextContent) {
        // We have text response - use it directly (covers both function execution and cancellation)
        text = finalTextContent;
        await discordMessage.edit({ content: text, embeds: [], components: [] }).catch(() => { });
      } else if (functionCallCount > 0) {
        // Executed functions but no text yet - stream a final response
        const streamResult = await withRetry(() => ai.models.generateContentStream({
          model: GEMINI_TOOL_MODEL,
          contents: conversationHistory.map(c => ({ role: c.role, parts: c.parts })),
          config: { systemInstruction },
        }));
        text = await handleStreamingResponse(streamResult, discordMessage, { embeds: [], components: [] });
      } else if (isActionFlow) {
        // Action flow but no function call and no text - fallback to chat
        const streamResult = await withRetry(() => ai.models.generateContentStream({
          model: GEMINI_TOOL_MODEL,
          contents: [{ role: 'user', parts: chatParts }],
          config: { systemInstruction: chatSystemInstruction },
        }));
        text = await handleStreamingResponse(streamResult, discordMessage);
      } else {
        // Regular chat response - stream it
        const streamResult = await withRetry(() => ai.models.generateContentStream({
          model: GEMINI_TOOL_MODEL,
          contents: [{ role: 'user', parts: chatParts }],
          config: { systemInstruction: chatSystemInstruction },
        }));
        text = await handleStreamingResponse(streamResult, discordMessage);
      }
    } catch (err) {
      console.error('Gemini Error:', err);
      await discordMessage.edit('❌ Error talking to Echo.').catch(() => null);
    } finally {
      stopGeminiCall();
    }

    // Store assistant reply
    if (!text) text = 'Echo didn\'t return any text.';

    // Send remaining chunks if response exceeds 1900 chars
    if (text.length > 1900) {
      const chunks = [];
      let remaining = text;
      while (remaining.length > 0) {
        chunks.push(remaining.slice(0, 1900));
        remaining = remaining.slice(1900);
      }

      // Edit first message (Chunk 1)
      if (chunks.length > 0) {
        await discordMessage.edit(chunks[0] + `\n**(Part 1/${chunks.length})**`).catch(() => { });
      }

      // Send subsequent chunks
      for (let i = 1; i < chunks.length; i++) {
        await channel.send(chunks[i] + `\n**(Part ${i + 1}/${chunks.length})**`);
      }
    }

    const replyTimestamp = new Date().toISOString();
    const botUserId = channel?.client?.user?.id || null;

    const stopStoreAssistant = startTimer('Store assistant reply', timings);
    try {
      await addMessage(channelId, {
        role: 'assistant',
        userId: botUserId,
        content: text,
        timestamp: replyTimestamp,
      }, guild ? guild.id : null);
    } finally {
      stopStoreAssistant();
    }

    // Observability logging
    try {
      const sanitizeForLog = (value) =>
        typeof value === 'string'
          ? value.replace(/[\r\n]+/g, ' ').replace(/\s\s+/g, ' ').trim()
          : String(value ?? '');

      const guildInfo = guild ? `${guild.name} (${guild.id})` : 'DM';
      // @ts-ignore - name property check
      const channelInfo = channel?.name || channel?.id || 'unknown-channel';
      const userInfo = senderUser?.tag || senderUser?.username || senderUser?.id || 'unknown-user';
      const logPrompt = sanitizeForLog(promptText);
      const logResponse = sanitizeForLog(text);

      console.info(`[Gemini Session] Guild=${guildInfo} | Channel=${channelInfo} | User=${userInfo} | Prompt="${logPrompt}" | Response="${logResponse}"`);
    } catch (logErr) {
      console.error('Failed to log session:', logErr);
    }

    // Schedule async maintenance
    scheduleMemoryMaintenance(conversationForSummary, channelId, guild, userInfoMap, timings);

  } finally {
    const totalDuration = stopTotalTimer();
    logTimingSummary(timings, totalDuration);
  }
}

/**
 * Handle streaming response with periodic Discord updates
 */
async function handleStreamingResponse(streamResult, message, options = {}) {
  let finalText = '';
  try {
    for await (const chunk of streamResult) {
      const chunkText = chunk.text || '';
      finalText += chunkText;

      if (finalText.length > 0 && finalText.length % 50 === 0) {
        if (finalText.length <= 1900) {
          await message.edit({ content: finalText, ...options }).catch(() => { });
        }
      }
    }

    if (!finalText || finalText.trim().length === 0) {
      finalText = '...';
    }
    if (finalText.length <= 1900) {
      await message.edit({ content: finalText, ...options }).catch(async (err) => {
        if (err.code === 10008 || err.status === 404 || err.code === 50006) {
          console.warn('Message not found or empty, replying with new message');
          try {
            if (finalText && finalText.trim().length > 0) {
              await message.channel.send(finalText);
            }
          } catch (replyErr) {
            console.error('Failed to send fallback message:', replyErr);
          }
        } else {
          throw err;
        }
      });
    }
  } catch (e) {
    console.error('Error streaming response:', e);
    if (finalText) {
      await message.edit({ content: finalText, ...options }).catch(async (err) => {
        if (err.code === 10008 || err.status === 404) {
          try {
            await message.channel.send(finalText);
          } catch (replyErr) {
            console.error('Failed to send fallback:', replyErr);
          }
        }
      });
    }
  }
  return finalText;
}

/**
 * Schedule async memory maintenance and summarization
 */
function scheduleMemoryMaintenance(conversationForSummary, channelId, guild, userInfoMap, parentTimings) {
  const maintenanceTask = (async () => {
    try {
      const timings = [];
      const stopSummaryTotal = startTimer('Memory maintenance', timings);

      const ai = getGeminiClient();
      const summaryPrompt = `
Summarise the following timestamped Discord channel conversation into a short background summary.
Keep it under 200 words, include key facts, long-running topics, and user preferences.
Do NOT invent new information.

Conversation:
  ${conversationForSummary}
`.trim();

      const stopGeminiSummary = startTimer('Gemini summary call', timings);
      const sumRes = await ai.models.generateContent({
        model: GEMINI_TEXT_MODEL,
        contents: [{ role: 'user', parts: [{ text: summaryPrompt }] }],
      });
      stopGeminiSummary();

      let newSummary = sumRes.text ?? '';
      if (!newSummary && sumRes.candidates) {
        try {
          newSummary = sumRes.candidates[0].content.parts
            .map(p => p.text || '')
            .join(' ')
            .trim();
        } catch {
          // ignore
        }
      }

      const maintenanceOps = [];

      if (newSummary) {
        maintenanceOps.push((async () => {
          const stopUpdate = startTimer('Update channel summary', timings);
          try {
            await updateChannelSummary(channelId, newSummary);
          } finally {
            stopUpdate();
          }
        })());
      }

      maintenanceOps.push((async () => {
        const stopTruncate = startTimer('Truncate messages', timings);
        try {
          await truncateOldMessages(channelId, MAX_CONTEXT_MESSAGES);
        } finally {
          stopTruncate();
        }
      })());

      if (guild) {
        maintenanceOps.push((async () => {
          const stopGuildUpdate = startTimer('Update guild memory', timings);
          try {
            const guildUsersPayload = Object.values(userInfoMap).map(u => ({
              id: u.id,
              displayName: u.displayName || u.username,
              shortName: u.displayName || u.username,
              nickname: u.nickname || null,
              username: u.username,
              roles: u.roles || [],
              tag: u.tag || null,
              avatar: u.avatar || null,
              bio: u.bio || null,
              note: u.note || null,
            }));

            await updateGuildMemory(guild.id, newSummary || '', JSON.stringify(guildUsersPayload));
            setCachedGuildMemory(guild.id, {
              summary: newSummary || '',
              users: JSON.stringify(guildUsersPayload),
            });
          } finally {
            stopGuildUpdate();
          }
        })());
      }

      await Promise.all(maintenanceOps);
      stopSummaryTotal();

      debugLog('Memory maintenance complete', timings);
    } catch (e) {
      console.error('Memory maintenance failed:', e);
    }
  })();

  maintenanceTask.catch(err => {
    console.error('Memory maintenance task crashed:', err);
  });

  return maintenanceTask;
}

module.exports = {
  runGeminiCore,
  handleStreamingResponse,
};
