// core/intervention-planner.js
// Gemini-powered decision engine for automated interventions
// Uses ServerState data to decide when and how Echo should proactively act
/** @typedef {import('discord.js').Guild} Guild */
/** @typedef {import('discord.js').TextChannel} TextChannel */
/** @typedef {import('./server-state').ServerState} ServerState */

// ============================================================================
// ARCHITECTURE OVERVIEW
// ============================================================================
//
// ServerState (from server-state.js)
//        │
//        ▼
// triggerIntervention(guildId, triggers, state)
//        │
//        ├── Check cooldown (prevent spam)
//        │
//        ├── Build prompt with state context
//        │
//        ├── Ask Gemini: "Should I act?"
//        │
//        ├── Parse decision (POST_SUMMARY or DO_NOTHING)
//        │
//        ├── Execute action if confidence > threshold
//        │
//        └── Log to intervention_history
//
// ============================================================================

const { getGeminiClient } = require('../gemini-client');
const { pool } = require('../db');
const { debugLog } = require('../utils/debugging');
const { getDiscordClient, isClientReady } = require('../discord-client');
const { PermissionsBitField } = require('discord.js');
const { GEMINI_TEXT_MODEL } = require('../config/models');

// ============================================================================
// CONFIGURATION
// ============================================================================

/** @type {{ URGENT: number, STANDARD: number, RELAXED: number }} */
const COOLDOWNS = {
    URGENT: 30 * 1000, // 30s (Safety/Help) - Brief debounce to prevent double-firing on same event
    STANDARD: 5 * 60 * 1000, // 5 minutes (Conflict)
    RELAXED: 15 * 60 * 1000  // 15 minutes (Mood/Nagging)
};

/** @type {{ [key: string]: keyof typeof COOLDOWNS }} */
const TRIGGER_TIERS = {
    'HELP_REQUEST': 'STANDARD',
    'SAFETY_RISK': 'URGENT',
    'CONFLICT': 'STANDARD',
    'mood_negative': 'RELAXED',
    'voice_activity': 'STANDARD',
    'mood_positive': 'RELAXED'
};

// Minimum confidence required to execute an action
// Below this threshold, the decision is logged but not executed
const MIN_CONFIDENCE = 0.6;

// In-memory cooldown tracking
// Key: guildId, Value: { timestamp: number, type: string }
const cooldowns = new Map();

// Channel name priorities for intervention messages
// Will try these names in order when looking for a channel to post to
const PREFERRED_CHANNEL_NAMES = ['general', 'chat', 'main', 'lobby', 'discussion'];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Find the best channel to post an intervention message
 * SMART TARGETING: Prefer source channel (minimize blast radius)
 * Fallback to #general only for server-wide context
 *
 * @param {Guild} guild - Discord guild object
 * @param {ServerState} [state] - Optional ServerState with sourceChannelId
 * @returns {TextChannel|null} - Best channel to post to, or null if none found
 */
function findBestChannel(guild, state) {
    const { ChannelType } = require('discord.js');

    // Get bot member object
    const botMember = guild.members.me;
    if (!botMember) return null;

    // Helper: Check if we can send to a channel
    /** @param {import('discord.js').GuildBasedChannel | null | undefined} ch */
    const canSend = (ch) => ch?.permissionsFor(botMember)?.has(PermissionsBitField.Flags.SendMessages);

    // Get all text channels
    const textChannels = guild.channels.cache.filter(
        ch => ch.type === ChannelType.GuildText
    );

    // PRIORITY 1: Try source channel (where the conflict happened)
    // This minimizes "blast radius" - keep intervention contextual
    if (state?.sourceChannelId) {
        const sourceChannel = textChannels.get(state.sourceChannelId);
        if (sourceChannel && canSend(sourceChannel)) {
            debugLog(`[Planner] Using source channel: #${sourceChannel.name}`);
            return sourceChannel;
        }
    }

    // PRIORITY 2: Try source channel by name (fallback if ID not found)
    if (state?.sourceChannelName) {
        const sourceByName = textChannels.find(
            ch => ch.name === state.sourceChannelName && canSend(ch)
        );
        if (sourceByName) {
            debugLog(`[Planner] Using source channel (by name): #${sourceByName.name}`);
            return sourceByName;
        }
    }

    // PRIORITY 3: Fallback to preferred channels (general, chat, main, etc.)
    // Only used for server-wide context, not dispute management
    for (const name of PREFERRED_CHANNEL_NAMES) {
        const channel = textChannels.find(
            ch => ch.name.toLowerCase().includes(name) && canSend(ch)
        );
        if (channel) return channel;
    }

    // PRIORITY 4: Last resort - any channel we can send to
    return textChannels.find(ch => canSend(ch)) || null;
}

/**
 * Format the intervention message with Echo's personality
 * Keeps it casual and natural without emojis
 *
 * @param {string} content - Raw intervention content from Gemini
 * @param {ServerState} state - Current ServerState
 * @returns {string} - Formatted message ready to send
 */
function formatInterventionMessage(content, state) {
    // Keep it simple and natural - Echo is a friend, not a corporate bot
    // No emojis, just casual conversation
    return content;
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

/**
 * @typedef {Object} InterventionDecision
 * @property {'POST_SUMMARY'|'DM_MODERATOR'|'DO_NOTHING'} action - The decided action
 * @property {string} content - Message content (if applicable)
 * @property {string} reasoning - Explanation for the decision
 * @property {number} confidence - Confidence score (0.0-1.0)
 * @property {boolean} [executed] - Whether the action was actually executed
 * @property {string} [channelId] - ID of the channel posted to (if applicable)
 */

// ============================================================================
// SYSTEM PROMPT FOR INTERVENTION DECISIONS
// ============================================================================

const INTERVENTION_SYSTEM_PROMPT = `
You are Echo's Intervention Planner.
Your job is to decide if Echo should proactively act based on the current server state.

You will receive:
1. Current mood score (-1.0 to 1.0)
2. Mood trend (rising, falling, stable)
3. Dominant signal (text, voice, mixed)
4. Current topics being discussed
5. Last voice summary (if available)
6. Detected triggers (mood_negative, conflict_detected, voice_activity, etc.)
7. Context markers (invisible context from past events that should influence your reasoning)

Context Marker Types:
- 'voice_tension' - Recent tension in voice chat. Be more charitable to text disagreements.
- 'high_stress_period' - Team is under deadline pressure. Be supportive, not critical.
- 'unresolved_tension' - Conflict not yet resolved. Watch for escalation.
- 'decision_pending' - Team is deciding something. Don't interrupt the process.

Your options:
1. POST_SUMMARY - Post a calming/clarifying message to text channel
2. DM_MODERATOR - Alert moderators privately (preferred for sensitive issues or persistent toxicity)
3. DO_NOTHING - Log observation but take no action

Decision Rules:
- POST_SUMMARY if mood is significantly negative (< -0.5) OR if conflict_detected trigger is present
- DM_MODERATOR if user mentions "stalking", "harassment", "suicide" OR asks for help privately regarding safety.
- For generic 'HELP_REQUEST' (e.g. asking for dates, info, features): DO_NOTHING or POST_SUMMARY. Do NOT alert mods for simple questions.
- If 'voice_tension' marker is active, interpret text disagreements more charitably
- If 'high_stress_period' marker is active, be extra supportive and patient
- For conflicts/quarrels: Be a peacemaker, not a moderator. Gently redirect the conversation.
- For SAFETY/STALKING/SELF-HARM: Do NOT post publicly. Use DM_MODERATOR immediately.
- For generic 'voice_activity' trigger: Default to DO_NOTHING unless the content clearly indicates a safety risk or immediate conflict.
- For stress: Be supportive and understanding, acknowledge the difficulty
- IGNORE sarcasm, playful banter, jokes, and friendly teasing - these are NOT conflicts
- If tension originated in voice, posting to text can help de-escalate
- Cross-modal actions are powerful: voice tension → text intervention
- When in doubt, DO_NOTHING - false positives annoy users more than misses
- Keep any message under 200 characters, casual and friendly like a friend speaking
- Never be preachy, robotic, or sound like a corporate bot
- Don't use too many emojis

Neutral Language Rules (CRITICAL for conflict channels):
- Be neutral and forward-looking, NOT judgmental or corrective
- Do NOT attribute fault to any individual ("Alex was wrong" ❌)
- Focus on ALIGNMENT, not correction ("Seems like views differ here" ✓)
- Use suggestive phrasing: "Want to sync up?", "Maybe take a breath?"
- Goal is to redirect energy, not moderate or lecture
- Example: "Lot of energy here - anyone want to step back and align?"

Output STRICT JSON only:
{
  "action": "POST_SUMMARY" | "DO_NOTHING",
  "content": "message text if POST_SUMMARY, empty string if DO_NOTHING",
  "reasoning": "one sentence explaining why",
  "confidence": 0.0-1.0
}
`.trim();

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Main entry point for intervention decisions
 * Called by analyzer.js when triggers are detected
 * 
 * @param {string} guildId - Discord guild ID
 * @param {string[]} triggers - Array of trigger names from checkTriggers()
 * @param {import('./server-state').ServerState} state - Current ServerState object
 * @returns {Promise<InterventionDecision|null>} - Decision object or null if skipped
 */
async function triggerIntervention(guildId, triggers, state) {

    // Determine highest priority trigger and its cooldown
    let cooldownTier = 'RELAXED'; // Default to relaxed
    let requiredCooldown = COOLDOWNS.RELAXED;

    for (const t of triggers) {
        const tier = TRIGGER_TIERS[t] || 'STANDARD';
        const duration = COOLDOWNS[tier];

        // Lower duration = Higher priority (Urgent=0 < Standard=5min < Relaxed=15min)
        if (duration < requiredCooldown) {
            requiredCooldown = duration;
            cooldownTier = tier;
        }
    }

    // Check cooldown
    const lastIntervention = cooldowns.get(guildId);

    // Get current time
    const now = Date.now();

    if (lastIntervention) {
        const timeSince = now - lastIntervention.timestamp;

        // If the new trigger is URGENT (0ms) but a RELAXED cooldown is active, we bypass it.
        // Logic: if timeSince < requiredCooldown, we are still cooling down for THIS tier.
        // But if requiredCooldown is 0 (Urgent), 0 < 0 is false, so we correctly proceed.
        if (timeSince < requiredCooldown) {
            debugLog(`[Planner] Cooldown active for ${guildId}. Wait ${Math.ceil((requiredCooldown - timeSince) / 1000)}s.`);
            return null; // Return null if cooldown is active
        }
    }

    // Set cooldown IMMEDIATELY to prevent race conditions (multiple triggers firing at once)
    // We update the timestamp again after the decision to ensure full duration
    cooldowns.set(guildId, { timestamp: Date.now(), type: cooldownTier });

    console.log(`[Planner] Evaluating intervention for ${guildId}`, triggers);

    // Build the context prompt for Gemini
    const contextPrompt = buildContextPrompt(state, triggers);

    try {
        // Call Gemini for decision
        const ai = getGeminiClient();
        const result = await ai.models.generateContent({
            model: GEMINI_TEXT_MODEL,
            contents: [{ role: 'user', parts: [{ text: contextPrompt }] }],
            config: {
                systemInstruction: INTERVENTION_SYSTEM_PROMPT,
                responseMimeType: 'application/json',
            },
        });

        // Parse Gemini's decision
        let decision;
        try {
            // Determine text from various SDK response shapes
            let rawText = '';

            // Shape 1: Direct .text property (newest SDK)
            if (typeof result.text === 'string') {
                rawText = result.text;
            }
            // Shape 2: result.response.text() function (GoogleGenAI SDK)
            else if (result.response && typeof result.response.text === 'function') {
                rawText = result.response.text();
            }
            // Shape 3: Raw API response with candidates array
            else if (result.candidates && result.candidates[0] && result.candidates[0].content) {
                rawText = result.candidates[0].content.parts[0].text;
            }
            // Shape 4: Hybrid (response.candidates)
            else if (result.response && result.response.candidates) {
                rawText = result.response.candidates[0].content.parts[0].text;
            }

            if (!rawText) {
                console.warn('[Planner] Gemini returned empty response. Keys:', Object.keys(result), 'Response keys:', result.response ? Object.keys(result.response) : 'N/A');
                decision = { action: 'DO_NOTHING', reasoning: 'Empty Gemini response', confidence: 0 };
            } else {
                decision = JSON.parse(rawText);
            }
        } catch (parseErr) {
            console.error('[Planner] Failed to parse Gemini response. Error:', /** @type {Error} */(parseErr).message, 'Result keys:', Object.keys(result || {}));
            decision = { action: 'DO_NOTHING', reasoning: 'Parse error', confidence: 0 };
        }

        debugLog(`[Planner] Decision for ${guildId}:`, decision);

        // Execute action if confidence threshold met
        if (decision.action === 'POST_SUMMARY' && decision.confidence >= MIN_CONFIDENCE) {
            // Post to Discord using the client singleton
            try {
                if (!isClientReady()) {
                    console.warn('[Planner] Discord client not ready, skipping post');
                    decision.executed = false;
                } else {
                    const client = getDiscordClient();
                    const guild = client.guilds.cache.get(guildId);

                    if (!guild) {
                        console.warn(`[Planner] Guild ${guildId} not found in cache`);
                        decision.executed = false;
                    } else {
                        // Find the best channel to post to
                        const targetChannel = findBestChannel(guild, state);

                        if (targetChannel) {
                            // Format the message with Echo's personality
                            const message = formatInterventionMessage(decision.content, state);
                            await targetChannel.send(message);

                            console.log(`[Planner] Posted to #${targetChannel.name} in ${guild.name}`);
                            decision.executed = true;
                            decision.channelId = targetChannel.id;
                        } else {
                            console.warn(`[Planner] No suitable channel found in ${guild.name}`);
                            decision.executed = false;
                        }
                    }
                }
            } catch (discordErr) {
                console.error('[Planner] Failed to post to Discord:', /** @type {Error} */(discordErr).message);
                decision.executed = false;
            }
        } else if (decision.action === 'DM_MODERATOR' && decision.confidence >= 0.7) {
            // Private alert to moderators
            try {
                if (isClientReady()) {
                    const client = getDiscordClient();
                    const guild = client.guilds.cache.get(guildId);
                    if (guild) {
                        await sendModeratorDMs(guild, decision.content);
                        decision.executed = true;
                        console.log(`[Planner] DM_MODERATOR executed for ${guild.name}`);
                    }
                }
            } catch (dmErr) {
                console.error('[Planner] Failed to execute DM_MODERATOR:', /** @type {Error} */(dmErr).message);
                decision.executed = false;
            }
        } else {
            decision.executed = false;

            if (decision.action === 'POST_SUMMARY' && decision.confidence < MIN_CONFIDENCE) {
                debugLog(`[Planner] Confidence too low (${decision.confidence} < ${MIN_CONFIDENCE}), not executing`);
            }
        }

        // Log decision to intervention_history (even DO_NOTHING for audit trail)
        await logIntervention(guildId, triggers, decision);

        // Update cooldown timestamp again to restart the clock from when the Action completed
        // This ensures minimum spacing between actions
        cooldowns.set(guildId, { timestamp: Date.now(), type: cooldownTier });

        return decision;

    } catch (err) {
        // If it failed, we might want to clear cooldown?
        // But for safety, let's leave it to prevent retry spam loop
        console.error(`[Planner] Failed to generate decision for ${guildId}:`, /** @type {Error} */(err).message);
        return null;
    }
}

/**
 * Build the context prompt for Gemini
 * Formats ServerState into a human-readable prompt
 *
 * @param {ServerState} state - ServerState object
 * @param {string[]} triggers - Array of trigger names
 * @returns {string} - Formatted prompt
 */
function buildContextPrompt(state, triggers) {
    // Format context markers for display
    const markers = Array.isArray(state.contextMarkers) && state.contextMarkers.length > 0
        ? state.contextMarkers.map((/** @type {import('./server-state').ContextMarker} */ m) => `${m.type}${m.topic ? ` (${m.topic})` : ''}`).join(', ')
        : 'none';

    return `
Current Server State:
- Mood Score: ${state.moodScore?.toFixed(2) || '0.00'} (${state.moodTrend || 'stable'})
- Dominant Signal: ${state.dominantSignal || 'text'}
- Topics: ${state.dominantTopics?.join(', ') || 'none detected'}
- Last Voice Summary: "${state.lastVoiceSummary || 'no recent voice activity'}"
- Triggers Detected: ${triggers.join(', ')}
- Active Context Markers: ${markers}

Based on this state, should Echo intervene?
`.trim();
}

/**
 * Log intervention decision to database
 * Records all decisions for auditing and dashboard display
 * 
 * @param {string} guildId - Discord guild ID
 * @param {string[]} triggers - Trigger names
 * @param {InterventionDecision} decision - Decision object from Gemini
 */
async function logIntervention(guildId, triggers, decision) {
    try {
        await pool.execute(
            `INSERT INTO intervention_history 
                (guild_id, trigger_type, action_taken, reasoning, confidence)
             VALUES (?, ?, ?, ?, ?)`,
            [
                guildId,
                triggers.join(','),
                decision.action,
                decision.reasoning,
                decision.confidence,
            ]
        );
        debugLog(`[Planner] Logged intervention to history`);
    } catch (err) {
        console.error('[Planner] Failed to log intervention:', /** @type {Error} */(err).message);
    }
}

/**
 * Get recent intervention history for a guild
 * Useful for dashboard display
 *
 * @param {string} guildId - Discord guild ID
 * @param {number} limit - Maximum number of records to return
 * @returns {Promise<object[]>} - Array of intervention records
 */
async function getInterventionHistory(guildId, limit = 10) {
    try {
        const [rows] = /** @type {[object[], any]} */ (await pool.query(
            `SELECT * FROM intervention_history
             WHERE guild_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [guildId, limit]
        ));
        return rows;
    } catch (err) {
        console.error('[Planner] Failed to fetch intervention history:', /** @type {Error} */(err).message);
        return [];
    }
}

/**
 * Clear cooldown for a guild (useful for testing)
 * 
 * @param {string} guildId - Discord guild ID
 */
function clearCooldown(guildId) {
    cooldowns.delete(guildId);
    debugLog(`[Planner] Cleared cooldown for ${guildId}`);
}

/**
 * Send DM to all moderators
 * @param {Guild} guild - Discord guild
 * @param {string} content - Message content
 */
async function sendModeratorDMs(guild, content) {
    try {
        // Fetch members to ensure cache is populated (important for permissions)
        await guild.members.fetch();

        const moderators = guild.members.cache.filter((/** @type {import('discord.js').GuildMember} */ m) =>
            !m.user.bot && (
                m.permissions.has(PermissionsBitField.Flags.Administrator) ||
                m.permissions.has(PermissionsBitField.Flags.ModerateMembers) ||
                m.permissions.has(PermissionsBitField.Flags.KickMembers) ||
                m.permissions.has(PermissionsBitField.Flags.BanMembers)
            )
        );

        const dmMessage = `🔔 **Echo Alert**\n${content}\n\n*No action taken by bot - this is a private heads-up.*`;

        let sentCount = 0;
        for (const [, mod] of moderators) {
            try {
                await mod.send(dmMessage);
                sentCount++;
            } catch (dmErr) {
                console.error(`[Intervention] Failed to DM moderator ${mod.user.tag}:`, /** @type {Error} */(dmErr).message);
                // Continue to next mod
            }
        }
        console.log(`[Intervention] Sent moderator alerts to ${sentCount} staff members.`);
    } catch (err) {
        console.error('[Intervention] Error in sendModeratorDMs:', /** @type {Error} */(err).message);
    }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    triggerIntervention,
    getInterventionHistory,
    clearCooldown,
    MIN_CONFIDENCE,
};
