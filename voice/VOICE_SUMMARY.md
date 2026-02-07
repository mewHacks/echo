# Voice System Architecture

**Echo Discord Bot - Gemini Live Voice Integration**

This document provides a comprehensive overview of the voice chat system, detailing the architecture, responsibilities, and implementation from high-level to low-level components.

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Component Breakdown](#component-breakdown)
3. [Data Flow](#data-flow)
4. [File Responsibilities](#file-responsibilities)
5. [Current Concerns](#current-concerns)
6. [Resilience & Recovery](#resilience--recovery)
7. [Future Improvements](#future-improvements)

---

## High-Level Overview

### System Purpose
Enable real-time voice conversations between Discord users and Gemini Live API, creating a seamless voice chat experience where users can speak naturally and receive AI-generated audio responses.

### Architecture Layers

### Privacy by Design: Ephemeral Streaming
**Crucial for User Trust:**
Echo treats voice data as **ephemeral**.
1.  **Stream:** Audio is streamed in real-time chunks to Gemini.
2.  **Process:** It is converted to semantic vectors instantly.
3.  **Discard:** The raw audio buffer is overwritten/discarded immediately.
**WE DO NOT STORE AUDIO FILES.** This architecture ensures we can offer safety features without becoming a surveillance tool.

```
┌─────────────────────────────────────────────────────────────┐
│                        USER LAYER                           │
│                   (Discord Voice Channel)                   │
└─────────────────────────────────────────────────────────────┘
                              ↓ Opus audio (Ephemeral)
┌─────────────────────────────────────────────────────────────┐
│                     COMMAND LAYER                           │
│                    commands/join.js                         │
│          • Entry point for voice sessions                   │
│          • Validates permissions and user state             │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                  ORCHESTRATION LAYER                        │
│                 voiceSessionManager.js                      │
│     • Manages session lifecycle                             │
│     • Coordinates all components                            │
│     • Handles Gemini Live WebSocket                         │
└─────────────────────────────────────────────────────────────┘
        ↙                     ↓                      ↘
┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐
│  INPUT       │    │  OUTPUT          │    │  UTILITIES       │
│  UserAudio   │    │  AudioStream     │    │  voice/utils.js  │
│  Receiver.js │    │  Manager.js      │    │                  │
│              │    │                  │    │  • PCM resampling│
│ • Opus decode│    │ • Stream lifecycle│   │  • FFmpeg transcode│
│ • Silence    │    │ • De-duplication │    │  • Format conversion│
│ • Speaker    │    │ • Backpressure   │    │                  │
│   switching  │    │                  │    │                  │
└──────────────┘    └──────────────────┘    └──────────────────┘
        ↓                     ↑                      ↑
        └─────────────────────┴──────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                    EXTERNAL LAYER                           │
│           • Gemini Live API (WebSocket)                     │
│           • Discord Voice Gateway (UDP)                     │
│           • @discordjs/voice library                        │
└─────────────────────────────────────────────────────────────┘
```

---

## Component Breakdown

### 1. Command Layer

#### `commands/join.js`
**Level:** High  
**Role:** User-facing entry point

**Responsibilities:**
- Validates user is in voice channel
- Checks bot permissions (Connect, Speak)
- Prevents duplicate sessions
- Parses voice preset selection
- Initiates voice session via `startVoiceSession()`
- Provides user feedback

**Key Functions:**
- `execute(interaction)` - Main command handler

---

### 2. Orchestration Layer

#### `voiceSessionManager.js`
**Level:** High-Medium  
**Role:** Central coordinator for voice sessions

**Responsibilities:**
- **Session Lifecycle:**
  - Creates and destroys voice sessions
  - Manages session state (active/destroyed)
  - Tracks sessions per voice channel

- **Connection Management:**
  - Joins Discord voice channels
  - Connects to Gemini Live WebSocket
  - Handles connection errors and reconnection

- **Component Coordination:**
  - Initializes `AudioStreamManager` for output
  - Initializes `UserAudioReceiver` for input
  - Routes audio between Discord ↔ Gemini

- **Business Logic:**
  - Hangup detection (via summary keyword)
  - Idle timeout (60 seconds of silence)
  - Stage channel permission handling
  - Graceful goodbye (waits for audio to finish)

**Key Classes:**
- `VoiceSession` - Main session orchestrator

**Key Functions:**
- `startVoiceSession()` - Creates new session
- `endVoiceSession()` - Destroys existing session
- `getVoiceSession()` - Retrieves active session
- `handleServerMessage()` - Processes Gemini messages
- `forwardPcmChunk()` - Sends user audio to Gemini
- `signalAudioStreamEnd()` - Signals end of user speech

---

### 3. Input Layer

#### `voice/UserAudioReceiver.js`
**Level:** Medium  
**Role:** Discord audio input processor

**Responsibilities:**
- **Audio Capture:**
  - Subscribes to Discord user audio streams
  - Decodes Opus → PCM (48kHz mono)
  - Forwards PCM to Gemini

- **Silence Detection:**
  - 750ms timer per utterance
  - Triggers `onSilence()` callback when user stops speaking
  - Signals Gemini to generate response

- **Speaker Management:**
  - Enforces single active speaker
  - Detects speaker switches
  - Interrupts current playback on switch

- **Error Handling:**
  - Graceful Opus decode errors (packet loss)
  - Auto-reconnection on stream failures
  - Error rate tracking (diagnostics)

**Key Classes:**
- `UserAudioReceiver`

**Key Functions:**
- `start()` - Begins listening to voice events
- `subscribe(userId)` - Subscribes to user's audio
- `unsubscribe(userId)` - Cleans up user's audio
- `handleChunk(userId, pcmBuffer)` - Processes audio chunk
- `handleSpeakerStart(userId)` - Manages speaker switching

**Audio Flow:**
```
Discord User → Opus Stream → Opus Decoder → PCM (48kHz mono) → Gemini
```

---

### 4. Output Layer

#### `voice/AudioStreamManager.js`
**Level:** Medium  
**Role:** Discord audio output processor

**Responsibilities:**
- **Stream Lifecycle:**
  - Creates PassThrough stream per Gemini "turn"
  - Writes audio chunks to stream
  - Closes stream on `turnComplete`

- **De-duplication:**
  - MD5 hashing of first 1KB
  - Detects and skips duplicate chunks
  - Maintains hash history (last 10)

- **Adaptive Backpressure:**
  - Tracks write latency
  - Enables backpressure when latency > 50ms
  - Disables when latency < 20ms
  - Balances smoothness vs. latency

- **Format Handling:**
  - Delegates to `utils.js` for conversion
  - Supports PCM, WAV, MP3, OGG via FFmpeg

**Key Classes:**
- `AudioStreamManager`

**Key Functions:**
- `createStream()` - Creates new playback stream
- `writeChunk(buffer, mimeType)` - Writes audio chunk
- `closeStream()` - Ends current stream
- `flush()` - Emergency stop (interruption)
- `updateLatencyMetrics()` - Adaptive backpressure logic

**Audio Flow:**
```
Gemini → PCM/WAV/MP3 → Format Conversion → Discord Audio Player
```

---

### 5. Utilities Layer

#### `voice/utils.js`
**Level:** Low  
**Role:** Audio processing primitives

**Responsibilities:**
- **PCM Processing:**
  - Sample rate conversion (e.g., 24kHz → 48kHz)
  - Channel conversion (mono → stereo)
  - Linear interpolation resampling

- **Format Transcoding:**
  - FFmpeg integration for WAV/MP3/OGG
  - Safe argument building (command injection prevention)
  - Stream-based processing

- **Security:**
  - MIME type sanitization
  - Prevents shell injection attacks

**Key Functions:**
- `ensurePcm48kStereo()` - Converts to Discord format
- `resampleMonoPcm()` - Resamples audio
- `downmixToMono()` - Multi-channel → mono
- `duplicateMonoToStereo()` - Mono → stereo
- `writeChunkToPlayback()` - Entry point for conversion
- `transcodeChunkToStream()` - FFmpeg transcoding
- `buildFfmpegArgs()` - Safe FFmpeg args
- `sanitizeMimeType()` - Security filter

---

## Data Flow

### User Speech → Gemini

```
1. User speaks in Discord
   ↓
2. Discord sends Opus packets (UDP)
   ↓
3. @discordjs/voice receives packets
   ↓
4. UserAudioReceiver subscribes to stream
   ↓
5. prism-media decodes Opus → PCM
   ↓
6. UserAudioReceiver forwards PCM to VoiceSession
   ↓
7. VoiceSession.forwardPcmChunk() sends to Gemini
   ↓
8. Gemini Live WebSocket receives audio
   ↓
9. After 750ms silence, UserAudioReceiver triggers onSilence()
   ↓
10. VoiceSession.signalAudioStreamEnd() sent to Gemini
    ↓
11. Gemini processes and generates response
```

### Gemini Response → User

```
1. Gemini sends audio chunks via WebSocket
   ↓
2. VoiceSession.handleServerMessage() receives
   ↓
3. VoiceSession.handleModelPart() extracts audio
   ↓
4. AudioStreamManager.writeChunk() called
   ↓
5. Hash-based de-duplication check
   ↓
6. utils.writeChunkToPlayback() converts format
   ↓
7. PCM written to PassThrough stream
   ↓
8. Discord audio player plays stream
   ↓
9. On turnComplete, AudioStreamManager.closeStream()
```

### Hangup Detection Flow

```
1. User says "goodbye" or similar
   ↓
2. Audio sent to Gemini as normal
   ↓
3. Gemini includes "<<<TERMINATE_SESSION>>>" in text summary
   ↓
4. VoiceSession.handleTextPart() detects keyword
   ↓
5. Sets sessionEndRequested flag
   ↓
6. On turnComplete, checks flag
   ↓
7. VoiceSession.scheduleDestroyAfterPlayback() called
   ↓
8. Polls audio player until idle
   ↓
9. VoiceSession.destroy() called
   ↓
10. Cleanup: streams, timers, connections
```

---

## File Responsibilities

### Summary Table

| File | Layer | Primary Role | Lines of Code |
|------|-------|--------------|---------------|
| `commands/join.js` | Command | User entry point | ~100 |
| `voiceSessionManager.js` | Orchestration | Session lifecycle & coordination | ~780 |
| `voice/UserAudioReceiver.js` | Input | Discord audio capture | ~290 |
| `voice/AudioStreamManager.js` | Output | Discord audio playback | ~250 |
| `voice/utils.js` | Utilities | Audio format conversion | ~320 |

### Dependency Graph

```
commands/join.js
    ↓ (requires)
voiceSessionManager.js
    ↓ (requires)
    ├─ voice/UserAudioReceiver.js
    │       ↓ (requires)
    │       └─ @discordjs/voice
    │       └─ prism-media
    │
    ├─ voice/AudioStreamManager.js
    │       ↓ (requires)
    │       ├─ @discordjs/voice
    │       └─ voice/utils.js
    │               ↓ (requires)
    │               ├─ prism-media (FFmpeg)
    │               └─ node:stream
    │
    └─ gemini-live.js (Gemini WebSocket client)
```

---

## Current Concerns

### 1. **Gemini Live API Instability**
**Severity:** High  
**Impact:** Random disconnections (code 1008)

The Gemini Live Preview API is unstable and can randomly close connections. This is an external issue beyond our control. The bot handles it gracefully by destroying the session, but it disrupts user experience.

**Evidence:**
- Frequent `code 1008` errors in logs
- `"Operation is not implemented, or supported, or enabled."`

**Mitigation:**
- Graceful session cleanup on disconnect
- Clear user messaging about beta status
- Session state tracking prevents orphaned sessions

---

### 2. **Opus Decoder Errors**
**Severity:** Medium  
**Impact:** Occasional audio loss (1-2 seconds)

Discord packet loss causes Opus decoder corruption. The decoder cannot recover and must be restarted, resulting in brief audio gaps.

**Evidence:**
- `TypeError: The compressed data passed is corrupted`
- Occurs in `prism-media` library (external)

**Mitigation:**
- Auto-reconnection via `unsubscribe()` → new decoder
- Error rate tracking (diagnostics)
- Conditional logging (reduces console spam)

---

## Resilience & Recovery

### Reconnection Strategy
**Goal:** Auto-reconnect on Gemini Live disconnections instead of destroying session

**Design:**
- **Exponential Backoff:** 1s, 2s, 4s, 8s (max 30s)
- **Retry Logic:** Max 3 attempts before giving up
- **Context Preservation:** Preserves conversation context across reconnections so the bot "remembers" what was just said
- **User Feedback:** Notifies users of reconnection attempts via Discord messages

**Benefits:**
- Better user experience during API instability
- Maintains conversation state
- Reduces need to manually `/join` again

**Risks & Mitigation:**
- **Risk:** Session state inconsistencies
- **Mitigation:** Strict state tracking in `voiceSessionManager.js`

---

## Future Improvements

### 1. **Advanced Audio Processing**

#### 1a. Noise Suppression
**Priority:** Medium  
**Complexity:** High

Integrate noise suppression library (e.g., RNNoise) to filter background noise before sending to Gemini.

**Benefits:**
- Cleaner audio input
- Better Gemini transcription accuracy
- More professional sound

**Implementation:**
- Add RNNoise wrapper in `voice/utils.js`
- Process PCM in `UserAudioReceiver` before forwarding
- Optional toggle via `/join` parameter

#### 1b. Echo Cancellation
**Priority:** Low  
**Complexity:** Very High

Prevent bot's own audio from being captured by users' microphones.

**Challenge:**
- Requires acoustic echo cancellation (AEC)
- Complex signal processing
- May not be necessary (Discord handles per-user audio)

---

### 2. **Multi-Speaker Support**
**Priority:** Medium  
**Complexity:** High

**Goal:** Allow multiple users to speak simultaneously without interruption

**Current Limitation:**
- Single active speaker enforced
- Speaker switches interrupt current playback

**Design:**
- Audio mixing in `UserAudioReceiver`
- Speaker identification via metadata
- Gemini context: "User A: ..., User B: ..."

**Challenges:**
- Gemini context window limits
- Audio mixing complexity
- Cross-talk handling

**Benefits:**
- Natural group conversations
- Better Discord voice chat experience

---

### 3. **Dynamic Silence Threshold**
**Priority:** Low  
**Complexity:** Low

**Goal:** Adapt silence timeout based on speech patterns

**Current:** Fixed 750ms timeout

**Design:**
- Track user's average pause length
- Adjust timeout: Fast speakers (500ms), slow speakers (1000ms)
- Per-user calibration

**Benefits:**
- More natural conversation flow
- Fewer false "end of utterance" triggers

---

### 4. **Audio Quality Metrics**
**Priority:** Medium  
**Complexity:** Medium

**Goal:** Track and expose audio quality metrics for debugging

**Metrics:**
- Packet loss rate (Opus errors / total packets)
- Average write latency
- Duplicate detection rate
- Silence detection accuracy

**Implementation:**
- Dashboard endpoint: `/api/voice/metrics`
- Periodic logging (every 5 minutes)
- Per-session statistics

**Benefits:**
- Identify quality issues
- Tune backpressure thresholds
- Validate improvements

---

### 5. **Voice Activity Detection (VAD)**
**Priority:** High  
**Complexity:** Medium

**Goal:** Improve silence detection with proper VAD algorithm

**Current:** Timer-based (750ms)

**Design:**
- Use WebRTC VAD or similar library
- Analyze audio energy levels
- More accurate "end of speech" detection

**Benefits:**
- Faster response times (no fixed delay)
- Better handling of natural pauses
- Reduces false triggers

**Implementation:**
- Add VAD library to `UserAudioReceiver`
- Replace timer-based logic
- Configurable sensitivity

---

### 6. **Conversation History**
**Priority:** Low  
**Complexity:** Medium

**Goal:** Persist voice conversation summaries to database

**Design:**
- Store Gemini text summaries per turn
- Link to user ID and timestamp
- Queryable via `/history voice` command

**Benefits:**
- User can review past conversations
- Analytics on usage patterns
- Debugging conversation flow

**Schema:**
```sql
voice_turns (
  id, session_id, user_id, timestamp,
  summary_text, duration_ms
)
```

---

### 7. **Custom Wake Words**
**Priority:** Low  
**Complexity:** High

**Goal:** Allow users to wake bot with custom phrase

**Current:** Bot always listening when in channel

**Design:**
- Wake word detection library (e.g., Porcupine)
- User configures: `/voice wake-word "Hey Echo"`
- Bot only forwards audio after wake word

**Benefits:**
- Privacy (bot not always listening)
- Better channel etiquette
- Optional "push-to-talk" alternative

**Challenges:**
- Wake word detection accuracy
- Latency overhead
- Multiple wake words per channel

---

### 8. **Voice Preset Switching**
**Priority:** Low  
**Complexity:** Low

**Goal:** Allow users to switch voice preset mid-conversation

**Current:** Voice selected at `/join`, fixed for session

**Design:**
- New command: `/voice preset Charon`
- Reconnects Gemini with new voice
- Maintains conversation context

**Implementation:**
- Add `changeVoicePreset()` to `VoiceSession`
- Disconnect current, reconnect with new voice
- Preserve conversation history

---

### 9. **Stream Recording**
**Priority:** Low  
**Complexity:** Medium

**Goal:** Allow users to record voice sessions

**Design:**
- `/voice record start` command
- Save raw PCM or transcode to MP3
- Upload to Discord or S3
- `/voice record stop` to end

**Legal Considerations:**
- Require explicit user consent
- Notify all participants
- Compliance with recording laws

**Implementation:**
- Add recording stream in `AudioStreamManager`
- Tee audio to file writer
- Metadata: timestamp, participants

---

## Conclusion

The voice system is a well-architected, modular design that successfully bridges Discord voice chat with Gemini Live API. Despite current limitations (API instability, Opus errors), the system is robust, maintainable, and positioned for future enhancements.

**Implemented Features:**
- ✅ Reconnection strategy with exponential backoff
- ✅ Context preservation across reconnections
- ✅ Cross-modal awareness (voice ↔ text)
- ✅ Hangup detection via keywords

**Next Steps:**
1. Monitor production stability
2. Gather user feedback on voice quality
3. Evaluate VAD integration (high impact)

Last updated: 2026-02-03

