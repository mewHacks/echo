# Quick Reference Guide

## Common Tasks

### Add a New Discord Action (e.g., Unban, Mute)
1.  **Edit `actions-config.js`**:
    - Add a new key to the object.
    - Define: `description`, `permission` (Discord bitflag name), `parameters` (JSON schema), and `execute` (async function).
    - **Context**: If your action needs to know about users/roles (like `timeout_member`), use `buildContext` to provide that data to the LLM.
2.  **Done**: The action is automatically registered with Gemini and will show the Confirmation UI when invoked.

### Change System Prompt
1.  **Edit `config/prompts.js`**.
2.  Modify `BASE_SYSTEM_PROMPT` or `TEXT_MODE_CONTEXT`.
3.  Restart the bot.

### Change Gemini Model
1.  **Edit `config/models.js`**.
2.  Update the model constant (e.g., `GEMINI_TOOL_MODEL`).

### Add Voice Preset
1. Edit `config/voices.js`
2. Add to `GEMINI_AVAILABLE_VOICES` array
3. Available in `/join voice` command

### Fix "Permission Denied" (Moderation)
1.  **Check Discord Permissions**: Does the bot have the permission (e.g., `Ban Members`)?
2.  **Check Role Hierarchy**: Is the bot's role **higher** than the target user's role in the Server Settings? The bot checks this explicitly in `actions-config.js`.

### View Live Dashboard
```bash
node scripts/dashboard.js
```
Shows: Server States, Intervention Log, Trending Topics, Observations.

### Adjust Intervention Cooldowns
Edit `core/intervention-planner.js`:
- `COOLDOWNS.URGENT` (0ms) - Safety/Help requests
- `COOLDOWNS.STANDARD` (5min) - Conflicts
- `COOLDOWNS.RELAXED` (15min) - Mood checks

### User Context Logic
-   **File**: `utils/user-context.js`
-   **Functions**: `buildUserInfo` (single), `buildUserInfoMap` (batch).
-   **Tip**: This logic handles fetching user details (nickname, roles) to give the AI context.

### Memory & History Logic
-   **File**: `utils/memory-context.js`
-   **Functions**: `getChannelMemory` (DB), `buildLiveChatText` (Discord API).
-   **Tip**: Logic for summarization and deciding what chat history to send to Gemini.

### Fix Attachment Processing
1. Check `utils/attachments.js`
2. Update `processAttachments()` or MIME types
3. Changes apply to chat command automatically

### Improve Performance
1. Check `utils/debugging.js` timings output (set DEBUG_GEMINI=1)
2. Look at slowest operations in timing summary
3. Optimize specific utility or config

## Import Patterns

**Core Logic:**
```javascript
const { runGeminiCore } = require('./core/gemini-orchestrator');
const { observe } = require('./core/observer');
const { triggerIntervention } = require('./core/intervention-planner');
const { getServerState } = require('./core/server-state');
```

**Configuration:**
```javascript
const { BASE_SYSTEM_PROMPT } = require('./config/prompts');
const { GEMINI_TEXT_MODEL } = require('./config/models');
const { GEMINI_AVAILABLE_VOICES } = require('./config/voices');
```

**Utilities:**
```javascript
const { buildUserInfo, buildUserInfoMap } = require('./utils/user-context');
const { buildChatHistoryText, buildLiveChatText } = require('./utils/memory-context');
const { processAttachments, getMimeTypeFromName } = require('./utils/attachments');
const { debugLog, startTimer } = require('./utils/debugging');
```

**Handlers:**
```javascript
const { showConfirmationDialog } = require('./handlers/confirmation-ui');
```

## Debugging

**Enable Debug Logs:**
Run with environment variable:
```bash
DEBUG_GEMINI=1 node .
```

**Check Timings:**
The bot logs timing summaries for each interaction (e.g., how long Gemini took, how long DB took). Look for `[Gemini DEBUG] Gemini timing summary` in the console.

## Database (MySQL)

**Tables:**
-   `messages`: Chat history (indexed by `guild_id`, `created_at`).
-   `channels` / `guilds`: AI summaries.
-   `observations`: AI-detected events (conflicts, spikes).
-   `daily_stats` / `emerging_topics`: Analytics data.
-   `analysis_cursor`: Progress tracker for background analysis.
-   `server_state`: Unified mood/topics/signal per guild.
-   `intervention_history`: All bot intervention decisions + reasoning.

**Schema Changes:**
If you change `schema.sql`, the bot attempts to run idempotent statements on startup. Complex migrations might need manual scripts (see `scripts/` folder).

## Deep Dive Documentation
- **[Intelligence Architecture](../core/INTELLIGENCE_SUMMARY.md)**: Logic for Server State, Triggers, and Interventions.
- **[Voice Architecture](../voice/VOICE_SUMMARY.md)**: Audio pipeline, Reconnection Strategy, and data flow.

