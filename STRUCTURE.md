# Echo - Code Structure

## Overview
Echo is an **Automated Intelligence System** for Discord, powered by Google Gemini. Beyond simple chatbots, Echo observes server activity, reasons about community dynamics, and proactively intervenes to maintain healthy conversations.

## Directory Structure

```
.
├── core/                    # Core AI logic and orchestration
│   ├── gemini-orchestrator.js    # Main Gemini interaction orchestrator
│   ├── intent-router.js          # Intent detection (chat vs action)
│   ├── analyzer.js               # Background message analysis logic
│   ├── observer.js               # Passive message observer/logger
│   ├── scheduler.js              # Task scheduler for analysis
│   ├── server-state.js           # Unified guild state (mood, events, triggers)
│   ├── intervention-planner.js   # Gemini-powered decision engine
│   ├── memory-tools.js           # On-demand context retrieval tools
│   └── INTELLIGENCE_SUMMARY.md   # Deep dive into the "Brain" logic
│
├── config/                  # Configuration
│   ├── prompts.js               # System prompts and prompt building
│   ├── models.js                # Gemini model constants
│   ├── voices.js                # Voice presets (28 official voices)
│   └── index.js                 # Re-exports
│
├── voice/                   # Voice chat components
│   ├── AudioStreamManager.js    # Manages outgoing audio to Discord
│   ├── UserAudioReceiver.js     # Handles incoming user audio from Discord
│   ├── utils.js                 # Audio processing utilities (PCM, sample rate conversion)
│   └── VOICE_SUMMARY.md         # Comprehensive voice architecture documentation 
│
├── handlers/                # Discord interaction handlers
│   └── confirmation-ui.js       # Action confirmation dialog UI
│
├── utils/                   # Reusable utility modules
│   ├── user-context.js          # User info building
│   ├── memory-context.js        # Chat history/memory context
│   ├── attachments.js           # Attachment processing
│   └── debugging.js             # Timing and debug logs
│
├── commands/                # Slash commands
│   ├── chat.js                  # /chat command
│   ├── join.js                  # /join voice command
│   └── analyze.js               # /analyze command
│
├── listeners/               # Discord event listeners
│   └── chat.js                  # messageCreate listener for @mentions
│
├── api/                     # Express API routes
│   ├── guildCount.js            # GET /api/guilds/count
│   └── index.js                 # API router builder
│
├── scripts/                 # Utility scripts
│   └── dashboard.js             # Real-time analytics dashboard (terminal UI)
│
├── actions-config.js        # Definition of all AI-callable Discord actions
├── admin-tool.js            # Tool schema generator
├── command-handler.js       # Function call executor 
├── discord-client.js        # Discord client singleton (shared instance)
├── gemini-client.js         # Gemini client caching 
├── gemini-live.js           # Gemini Live API integration 
├── voiceSessionManager.js   # Voice session management with auto-reconnect
├── memoryStore.js           # Database access layer
├── db.js                    # MySQL connection pool
├── index.js                 # Entry point
├── deploy-commands.js       # Discord slash command registration script
├── schema.sql               # Database schema
├── package.json             # Dependencies and scripts
├── STRUCTURE.md             # This file
├── README.md                # Project overview
└── QUICK_REFERENCE.md       # Quick start guide
```

## Core Modules (`core/`)

**gemini-orchestrator.js**
- The brain of the bot's direct interaction.
- Orchestrates: Context gathering -> Gemini API call -> Function Execution -> Response.
- Handles multi-turn function calling (e.g. permission checks, confirmations).
- Supports Manual Tool Mode for Gemini 3 Preview models.

**intent-router.js**
- Detects if user request is for chat or action (moderation).
- Separate from orchestrator for testability.
- **Why separate**: Can be unit tested independently.

**observer.js**
- Passively logs every message to the database for analysis.
- Ensures `channels` and `analysis_cursor` records exist to prevent foreign key errors.
- Calls `triggerCheck()` immediately after observing messages for real-time analysis.

**analyzer.js & scheduler.js**
- `scheduler.js`: Periodically checks which guilds have enough new messages to analyze.
- `analyzer.js`: Processes "batches" of messages to generate insights (topics, sentiment).
- Detects the most active channel in each batch for targeted interventions.
- Identifies CONFLICT, HELP_REQUEST, SPAM events with confidence scores.

**server-state.js**
- Centralizes guild state management.
- Aggregates data from text analysis, voice summaries, and user inputs.
- Computes `moodScore`, `dominantSignal`, and tracks `recentEvents`.
- Pushes actual event types (CONFLICT, HELP_REQUEST) as triggers for intervention logic.
- **Purpose**: The "Shared Memory" in the Unified Loop.

**intervention-planner.js**
- Decides IF and HOW to intervene based on server state triggers.
- Uses Gemini 3 to generate context-aware interventions, BUT bypasses it for Safety.
- **Triggers**: `SAFETY_RISK`, `mood_negative`, `CONFLICT`, `HELP_REQUEST`, `voice_activity`.
- **CRITICAL SAFETY OVERRIDE**: If `SAFETY_RISK` regex triggers, instantly executes `DM_MODERATOR` without asking Gemini.
- **Smart Cooldowns**:
  - `SAFETY_RISK`: 0 min (Immediate)
  - `HELP_REQUEST`: 0 min (Immediate)
  - `CONFLICT`: 5 min (Standard)
  - `mood_negative`: 15 min (Anti-Nag)
- **Purpose**: The "Reasoned Decision" system (with Safety limits).

**memory-tools.js**
- Provides Gemini-callable tools for on-demand context retrieval.
- `search_channel_history`: Search messages across channels.
- `get_channel_summary`: Get summaries of specific channels.
- `get_server_state`: Get current mood/trends.
- **Purpose**: Enables "Smart Context Retrieval".

**INTELLIGENCE_SUMMARY.md**
- Detailed documentation of the "Observe → Reason → Act" loop.
- Explains Server State logic, Smart Triggers, and Intervention Policies.
- **Purpose**: The "Brain" user manual.
## Config Modules (`config/`)

**prompts.js**
- Defines the `BASE_SYSTEM_PROMPT` used to instruct the AI's personality and rules.
- Contains `buildSystemPrompt` to dynamically inject date/time into the prompt.
- **Language Rules:**
  - Explicit English-first rule to prevent unwanted language switching
  - Only switches language when user speaks it first
  - Removed Chinese examples from prompts to prevent contamination

**models.js**
- Single source of truth for Gemini model names (e.g., `GEMINI_TEXT_MODEL`).
- Helps avoid hardcoding "gemini-3-flash-preview" in multiple places.
- **Note:** `GEMINI_TRANSCRIBE_MODEL` is defined but currently unused (legacy code).

**voices.js**
- Configures all 28 official Gemini Live voices (alphabetically sorted)
- **Available voices:** Achernar, Achird, Algenib, Algieba, Alnilam, Aoede, Autonoe, Callirrhoe, Charon, Despina, Enceladus, Erinome, Fenrir, Gacrux, Iapetus, Kore, Laomedeia, Leda, Orus, Puck, Pulcherrima, Rasalgethi, Sadachbia, Sadaltager, Schedar, Umbriel, Zephyr, Zubenelgenubi

**index.js**
- Re-exports all config for backward compatibility
- Also imports the deprecated gemini-config pattern
- **Import**: `const { GEMINI_TEXT_MODEL, buildSystemPrompt } = require('./config')`

## Handler Modules (`handlers/`)

**confirmation-ui.js**
- Manages the interactive Embeds and Buttons for dangerous actions.
- **Key Function**: `showConfirmationDialog({ actionName, details... })`
- Decouples UI logic from the AI orchestrator.

## Root-Level Files

**index.js**
- Main entry point for the Discord bot
- Loads commands from `/commands` directory
- Registers event listeners from `/listeners`
- Starts Express API server on port 3000
- Handles graceful shutdown on process termination
- **Discord Client Singleton**: Uses `discord-client.js` to share client instance.

**discord-client.js**
- Singleton module to provide global access to the Discord client instance.
- Prevents circular dependencies when modules need to send messages (e.g., intervention planner).

**deploy-commands.js**
- Registers slash commands with Discord API
- **Usage:** `node deploy-commands.js`
- Updates command definitions across all guilds
- Run this after modifying any command files

**package.json**
- Project dependencies and npm scripts
- **Key dependencies:** discord.js, @google/generative-ai, express, mysql2
- **Scripts:** `start` (runs bot), `deploy` (updates commands)

**README.md**
- Project overview and feature list
- Setup instructions and configuration guide
- Command documentation

**QUICK_REFERENCE.md**
- Quick start guide for developers
- Common commands and workflows
- Troubleshooting tips

## Utility Modules (`utils/`)

**user-context.js**
- Fetches and formats user data (Roles, Nicknames) so the AI understands who it's talking to.
- deeply integrates with Discord.js cache for performance.

**memory-context.js**
- Builds the "Short Term Memory" for the AI.
- Fetches recent messages from the channel to provide conversation history.

**attachments.js**
- Handles image/file downloads and converts them to base64 for Gemini Vision.

**debugging.js (40 lines)**
- Timing utilities
- Debug logging
- Performance logging
- **Why separate**: Can be reused for other modules' performance tracking
- **Functions**: `debugLog()`, `startTimer()`, `logTimingSummary()`

## Voice Modules (`voice/`)

**AudioStreamManager.js**
- Manages outgoing audio playback to Discord voice channel
- Handles PCM-to-Opus conversion for Discord compatibility
- Implements audio de-duplication using content hashing
- Controls audio playback state and queue management
- **Key Features:**
  - Prevents duplicate audio chunks from playing twice
  - Handles backpressure when Discord voice buffer is full
  - Clean stop/destroy lifecycle management

**UserAudioReceiver.js**
- Captures and processes incoming user audio from Discord
- Handles Opus-to-PCM decoding for Gemini compatibility
- Implements silence detection (750ms threshold)
- Manages speaker switching and active speaker tracking
- **Key Features:**
  - Graceful degradation on Opus decode errors
  - Per-user audio stream subscriptions
  - Silence detection triggers Gemini response generation
  - Forwards clean PCM audio to Gemini Live

**utils.js**
- Audio processing utilities for format conversion
- **Functions:**
  - `convertSampleRate()`: Resamples audio between rates (e.g., 48kHz → 24kHz)
  - `normalizeChannels()`: Converts stereo to mono
  - `correctPcmFormat()`: Ensures correct bit depth and endianness
  - `transcodeWithFFmpeg()`: FFmpeg integration for complex conversions
- **Security:** Sanitizes file paths to prevent command injection

**VOICE_SUMMARY.md**
- Comprehensive architecture documentation for voice system
- Flow diagrams, component interactions, data formats
- Troubleshooting guide and future improvements

## Scripts (`scripts/`)

**dashboard.js**
- Real-time analytics terminal dashboard
- **Features:**
  - **Server States**: Per-guild mood score, trend, dominant signal (NEW)
  - **Intervention Log**: Recent decisions with reasoning and confidence (NEW)
  - **Today's Pulse**: Message count, users, sentiment metrics
  - **Trending Topics**: Top 5 with decay algorithm
  - **Recent Observations**: Event stream
  - Color-coded metrics (🟢 positive, 🔴 negative, 🟡 neutral)
- **Usage:** `node scripts/dashboard.js`
- **Dependencies:** None (uses terminal escape codes for UI)

## Voice Session Management (`voiceSessionManager.js`)

**Core Responsibilities:**
- Manages Discord voice connections and **Gemini Live (Gemini 2.5 Flash)** usage.
- Handles real-time audio streaming bidirectionally using **Ephemeral Privacy** (no storage).
- Coordinates between Discord voice, Gemini API, and user audio processing
- **Updates ServerState**: Pushes voice summaries to `server-state.js` for cross-modal awareness.

**Reconnection Strategy (2026-01-10):**
- **Auto-reconnect on disconnections:** Automatically recovers from Gemini Live errors
- **Exponential backoff:** 1s → 2s → 4s (max 30s)
- **Max 3 retry attempts** before giving up
- **Context preservation:** Stores last 3 conversation summaries (max 400 chars, 5min time limit)
- **Smart filtering:**
  - Code 1000 (normal close): No reconnect
  - Code 1007 (invalid config): No reconnect (prevents infinite loops)
  - Code 1008 (server error): Reconnects
  - Code 1006 (abnormal): Reconnects
- **User notifications:** Discord messages inform users of reconnection status
- **Defensive guards:** Prevents duplicate reconnection attempts via flag checks

**Language Handling:**
- Explicit "English-first" rule in voice session context
- Only switches language when user speaks it first
- Prevents random language switching based on server names or usernames

## Database Schema (`schema.sql`)

The bot uses MySQL with the following key tables:
- `messages`: Stores all chat logs. (Note: No foreign key on `channel_id` to allow flexible logging).
- `channels` & `guilds`: Stores AI-generated summaries.
- `observations`: Stores discrete AI-detected events (e.g., Sentiment Spikes).
- `daily_stats` & `emerging_topics`: Stores analytical insights.
- `analysis_cursor`: Tracks analysis progress per guild.
- `server_state`: Stores the current unified state (mood, topics, signal source).
- `intervention_history`: Logs all proactive actions taken by the bot.

## Action Configuration (`actions-config.js`)

This is the single source of truth for all tools the AI can use (e.g., `kick_member`, `timeout_member`).
Each action defines:
- **Permission**: Required Discord permission (e.g., `ModerateMembers`).
- **Parameters**: JSON schema for LLM args.
- **Execute**: The actual Javascript function to run.
- **Context (Optional)**: If the AI needs a list of members/roles to make a decision (e.g., for `timeout_member`), `buildContext` provides it.

## Key Relationships

1.  **User Message** → `listeners/chat.js` → `core/observer.js` (Log to DB)
2.  **User Message** → `listeners/chat.js` → `core/gemini-orchestrator.js` (If mentioned)
3.  **Orchestrator** → `actions-config.js` → `handlers/confirmation-ui.js` (If action taken)
4.  **Background** → `core/scheduler.js` → `core/analyzer.js` (Periodic analysis)
5.  **Voice Session** → `voiceSessionManager.js` → `gemini-live.js` → Gemini Live API

## Troubleshooting

- **Permission Denied**: The bot checks *both* Discord permissions AND Role Hierarchy. If `timeout_member` fails, ensure the bot's role is higher than the target's role.
- **Incorrect IDs**: `gemini-orchestrator.js` forces context loading for moderation actions to prevent the AI from hallucinating user IDs.
- **Voice disconnects**: Auto-reconnection handles transient Gemini Live errors. Check logs for "Reconnection successful" or "Failed to reconnect" messages.
- **Random language switching**: Ensure language rules are properly configured in both `config/prompts.js` and voice session context.

## Key Principles

1. **Single Responsibility**: Each module does one thing well
2. **Reusability**: Utilities are independent and composable
3. **Testability**: Each module can be unit tested independently
4. **Clarity**: File names and locations are self-documenting
5. **Maintainability**: Changes to prompts don't affect code logic
6. **Resilience**: Auto-reconnection and defensive programming prevent service disruption

## Performance Considerations

- **Caching**: Guild memory cached for 60 seconds
- **Lazy Loading**: Modules loaded only when needed
- **Async**: Memory maintenance runs in background
- **Streaming**: Gemini responses streamed to Discord in real-time
- **Reconnection**: Conversation context limited to 400 chars to minimize token usage

## Known Limitations

### Guild-Level Context (Not User-Level)
Echo tracks **guild-level** emotional context:
- "The server mood is stressed"
But not individual user relationships:
- "User A and User B had a conflict"

**Implication**: If A-B have tension in voice, and later B-C have a text disagreement, Echo may apply the stress context to B-C incorrectly.

**Design Decision**: This is accepted for the current version. User-to-user relationship tracking would require:
- Text: Participant extraction from messages (2-3h effort)
- Voice: Speaker diarization (not available in Gemini Live API)

### Voice Speaker Identification
Gemini Live API does not provide speaker identification. 
Echo knows:
- "Someone in voice is speaking"
- "The voice conversation is tense" (from semantic summary)
But not:
- "User A said this specific thing"

**Future Enhancement**: When Gemini Live adds speaker diarization, this can be implemented.

### Intervention Philosophy
Echo prioritizes **facilitation over moderation**:
- Summarize, clarify, capture decisions
- Kick/ban/timeout available but rarely recommended
- Never demo punitive actions to judges

This is a deliberate design choice — "knowing when NOT to act" is intelligence.

Last updated: 2026-02-03
