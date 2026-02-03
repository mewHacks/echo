// tests/server-state.test.js
// Unit tests for the ServerState module (core/server-state.js)
// Comprehensive tests for >95% coverage

// =========================================================================
// MOCK SETUP - Must be before requires
// =========================================================================

const mockConnection = {
    query: jest.fn().mockResolvedValue([[], []]),
    release: jest.fn(),
};

const mockPool = {
    getConnection: jest.fn().mockResolvedValue(mockConnection),
    query: jest.fn().mockResolvedValue([[], []]),
};

jest.mock('../db', () => ({
    pool: mockPool,
}));

jest.mock('../utils/debugging', () => ({
    debugLog: jest.fn(),
}));

// =========================================================================
// IMPORTS - After mocks
// =========================================================================

const {
    checkTriggers,
    getServerState,
    updateServerState,
    setContextMarker,
    getActiveContextMarkers,
    clearContextMarker,
    TRIGGERS,
    VOICE_EXPIRATION_MS,
} = require('../core/server-state');

// =========================================================================
// HELPERS
// =========================================================================

/**
 * Helper to create a full ServerState object with defaults
 * @param {Object} [overrides]
 * @returns {import('../core/server-state').ServerState}
 */
function createMockState(overrides = {}) {
    return {
        guildId: 'test-guild',
        moodScore: 0,
        moodTrend: 'stable',
        dominantTopics: [],
        openCommitments: [],
        contextMarkers: [],
        lastVoiceSummary: null,
        lastVoiceTimestamp: null,
        source: 'text',
        dominantSignal: 'text', // 'text', 'voice', or 'mixed'
        confidence: 0,
        recentEvents: [],
        sourceChannelId: null,
        sourceChannelName: null,
        updatedAt: new Date(),
        ...overrides,
    };
}


function resetAllMocks() {
    mockConnection.query.mockReset().mockResolvedValue([[], []]);
    mockConnection.release.mockReset();
    mockPool.getConnection.mockReset().mockResolvedValue(mockConnection);
}

// =========================================================================
// TESTS
// =========================================================================

describe('ServerState Module', () => {
    beforeEach(() => {
        resetAllMocks();
        jest.clearAllMocks();
    });

    // =========================================================================
    // checkTriggers() Tests
    // =========================================================================
    describe('checkTriggers()', () => {
        it('should return empty array for neutral state', () => {
            const state = createMockState({
                moodScore: 0,
                moodTrend: 'stable',
            });

            const triggers = checkTriggers(state);
            expect(triggers).toEqual([]);
        });

        it('should detect mood_negative when moodScore < -0.5', () => {
            const state = createMockState({
                moodScore: -0.6,
                moodTrend: 'falling',
            });

            const triggers = checkTriggers(state);
            expect(triggers).toContain('mood_negative');
        });

        it('should NOT detect mood_negative when moodScore = -0.5 (boundary)', () => {
            const state = createMockState({
                moodScore: -0.5,
                moodTrend: 'stable',
            });

            const triggers = checkTriggers(state);
            expect(triggers).not.toContain('mood_negative');
        });

        it('should detect mood_negative when moodScore = -0.51 (just below threshold)', () => {
            const state = createMockState({
                moodScore: -0.51,
                moodTrend: 'falling',
            });

            const triggers = checkTriggers(state);
            expect(triggers).toContain('mood_negative');
        });

        it('should detect mood_positive when moodScore > 0.7', () => {
            const state = createMockState({
                moodScore: 0.8,
                moodTrend: 'rising',
            });

            const triggers = checkTriggers(state);
            expect(triggers).toContain('mood_positive');
        });

        it('should NOT detect mood_positive when moodScore = 0.7 (boundary)', () => {
            const state = createMockState({
                moodScore: 0.7,
                moodTrend: 'stable',
            });

            const triggers = checkTriggers(state);
            expect(triggers).not.toContain('mood_positive');
        });

        it('should detect voice_activity when lastVoiceSummary exists', () => {
            const state = createMockState({
                lastVoiceSummary: 'Team discussed project updates',
            });

            const triggers = checkTriggers(state);
            expect(triggers).toContain('voice_activity');
        });

        // Test removed: Safety scan moved to voiceSessionManager.js
        // for (const keyword of safetyKeywords) {
        //    ...
        // }
    });

    it('should detect CONFLICT from recentEvents with high confidence', () => {
        const state = createMockState({
            moodScore: -0.3,
            moodTrend: 'falling',
            recentEvents: [
                { type: 'CONFLICT', desc: 'Heated argument detected', confidence: 0.8 }
            ],
        });

        const triggers = checkTriggers(state);
        expect(triggers).toContain('CONFLICT');
    });

    it('should NOT detect CONFLICT from recentEvents with low confidence', () => {
        const state = createMockState({
            moodScore: -0.3,
            moodTrend: 'falling',
            recentEvents: [
                { type: 'CONFLICT', desc: 'Possible disagreement', confidence: 0.5 }
            ],
        });

        const triggers = checkTriggers(state);
        expect(triggers).not.toContain('CONFLICT');
    });

    it('should detect CONFLICT at exactly 0.7 confidence (boundary)', () => {
        const state = createMockState({
            recentEvents: [
                { type: 'CONFLICT', desc: 'Argument', confidence: 0.7 }
            ],
        });

        const triggers = checkTriggers(state);
        expect(triggers).toContain('CONFLICT');
    });

    it('should detect HELP_REQUEST from recentEvents', () => {
        const state = createMockState({
            recentEvents: [
                { type: 'HELP_REQUEST', desc: 'User asking for immediate help', confidence: 0.9 }
            ],
        });

        const triggers = checkTriggers(state);
        expect(triggers).toContain('HELP_REQUEST');
    });

    it('should handle multiple simultaneous triggers', () => {
        const state = createMockState({
            moodScore: -0.8,
            moodTrend: 'falling',
            lastVoiceSummary: 'Discussion about harassment',
            recentEvents: [
                { type: 'CONFLICT', desc: 'Argument', confidence: 0.9 }
            ],
        });

        const triggers = checkTriggers(state);
        expect(triggers).toContain('mood_negative');
        expect(triggers).toContain('voice_activity');
        // expect(triggers).toContain('HELP_REQUEST'); // Moved to voiceSessionManager
        expect(triggers).toContain('CONFLICT');
        expect(triggers.length).toBe(3);
    });

    it('should handle null/undefined recentEvents gracefully', () => {
        const state = createMockState({
            recentEvents: null,
        });

        const triggers = checkTriggers(state);
        expect(triggers).toEqual([]);
    });

    it('should handle empty recentEvents array', () => {
        const state = createMockState({
            recentEvents: [],
        });

        const triggers = checkTriggers(state);
        expect(triggers).toEqual([]);
    });

    it('should ignore SPAM events (only CONFLICT and HELP_REQUEST matter)', () => {
        /** @type {any} */ // Force test specific invalid logic for test coverage
        const state = createMockState({
            recentEvents: [
                { type: 'SPAM', desc: 'Repeated messages', confidence: 0.9 }
            ],
        });

        const triggers = checkTriggers(state);
        expect(triggers).not.toContain('SPAM');
        expect(triggers).toEqual([]);
    });
});

// =========================================================================
// getServerState() Tests
// =========================================================================
describe('getServerState()', () => {
    it('should return default state when no record exists in DB', async () => {
        mockConnection.query.mockResolvedValueOnce([[], []]);

        const state = await getServerState('guild-123');

        expect(state.guildId).toBe('guild-123');
        expect(state.moodScore).toBe(0);
        expect(state.moodTrend).toBe('stable');
        expect(state.dominantTopics).toEqual([]);
        expect(state.dominantSignal).toBe('text');
    });

    it('should fetch and parse state from database', async () => {
        const dbRow = {
            guild_id: 'guild-123',
            mood_score: 0.5,
            mood_trend: 'rising',
            dominant_topics: JSON.stringify(['gaming', 'coding']),
            open_commitments: JSON.stringify([]),
            last_voice_summary: 'Team meeting notes',
            last_voice_timestamp: new Date(),
            source: 'voice',
            dominant_signal: 'mixed',
            confidence: 0.8,
            updated_at: new Date(),
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);

        const state = await getServerState('guild-123');

        expect(state.guildId).toBe('guild-123');
        expect(state.moodScore).toBe(0.5);
        expect(state.moodTrend).toBe('rising');
        expect(state.dominantTopics).toEqual(['gaming', 'coding']);
        expect(state.lastVoiceSummary).toBe('Team meeting notes');
        expect(state.source).toBe('voice');
        expect(state.dominantSignal).toBe('mixed');
    });

    it('should use cache on second call', async () => {
        const dbRow = {
            guild_id: 'guild-456',
            mood_score: 0.3,
            mood_trend: 'stable',
            dominant_topics: '[]',
            open_commitments: '[]',
            last_voice_summary: null,
            last_voice_timestamp: null,
            source: 'text',
            dominant_signal: 'text',
            confidence: 0.5,
            updated_at: new Date(),
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);

        // First call - hits DB
        await getServerState('guild-456');

        // Second call - should use cache
        await getServerState('guild-456');

        // DB should only be called once
        expect(mockConnection.query).toHaveBeenCalledTimes(1);
    });

    it('should expire voice summary if older than VOICE_EXPIRATION_MS', async () => {
        const oldTimestamp = new Date(Date.now() - VOICE_EXPIRATION_MS - 60000); // 11 minutes ago
        const dbRow = {
            guild_id: 'guild-789',
            mood_score: 0,
            mood_trend: 'stable',
            dominant_topics: '[]',
            open_commitments: '[]',
            last_voice_summary: 'Old voice summary',
            last_voice_timestamp: oldTimestamp,
            source: 'voice',
            dominant_signal: 'voice',
            confidence: 0.7,
            updated_at: new Date(),
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);

        const state = await getServerState('guild-789');

        // Voice summary should be retained for context, but signal reset
        expect(state.lastVoiceSummary).toBe('Old voice summary');
        expect(state.source).toBe('text');
        expect(state.dominantSignal).toBe('text');
    });

    it('should NOT expire voice summary if within VOICE_EXPIRATION_MS', async () => {
        const recentTimestamp = new Date(Date.now() - 60000); // 1 minute ago
        const dbRow = {
            guild_id: 'guild-recent',
            mood_score: 0,
            mood_trend: 'stable',
            dominant_topics: '[]',
            open_commitments: '[]',
            last_voice_summary: 'Recent voice summary',
            last_voice_timestamp: recentTimestamp,
            source: 'voice',
            dominant_signal: 'voice',
            confidence: 0.7,
            updated_at: new Date(),
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);

        const state = await getServerState('guild-recent');

        expect(state.lastVoiceSummary).toBe('Recent voice summary');
    });

    it('should handle malformed JSON in dominant_topics gracefully', async () => {
        const dbRow = {
            guild_id: 'guild-bad-json',
            mood_score: 0,
            mood_trend: 'stable',
            dominant_topics: '{invalid json',
            open_commitments: '[]',
            last_voice_summary: null,
            last_voice_timestamp: null,
            source: 'text',
            dominant_signal: 'text',
            confidence: 0.5,
            updated_at: new Date(),
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);

        const state = await getServerState('guild-bad-json');

        // Should fall back to empty array
        expect(state.dominantTopics).toEqual([]);
    });

    it('should handle null fields gracefully', async () => {
        const dbRow = {
            guild_id: 'guild-nulls',
            mood_score: null,
            mood_trend: null,
            dominant_topics: null,
            open_commitments: null,
            last_voice_summary: null,
            last_voice_timestamp: null,
            source: null,
            dominant_signal: null,
            confidence: null,
            updated_at: null,
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);

        const state = await getServerState('guild-nulls');

        expect(state.moodScore).toBe(0);
        expect(state.moodTrend).toBe('stable');
        expect(state.dominantTopics).toEqual([]);
        expect(state.source).toBe('text');
        expect(state.dominantSignal).toBe('text');
    });
});

// =========================================================================
// updateServerState() Tests
// =========================================================================
describe('updateServerState()', () => {
    beforeEach(() => {
        // Clear cache by getting a "fresh" state first
        mockConnection.query.mockResolvedValue([[], []]);
    });

    it('should update state and persist to database', async () => {
        const updates = {
            moodScore: 0.7,
            moodTrend: 'rising',
            dominantTopics: ['celebration'],
            source: 'text',
        };

        const result = await updateServerState('guild-update', updates);

        expect(result.moodScore).toBe(0.7);
        expect(result.moodTrend).toBe('rising');
        expect(result.dominantTopics).toEqual(['celebration']);

        // Verify DB was called with INSERT ... ON DUPLICATE KEY UPDATE
        expect(mockConnection.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO server_state'),
            expect.any(Array)
        );
    });

    it('should compute dominantSignal as text when all sources are text', async () => {
        // Make 3 updates with source: 'text'
        await updateServerState('guild-text', { moodScore: 0.1, source: 'text' });
        await updateServerState('guild-text', { moodScore: 0.2, source: 'text' });
        const result = await updateServerState('guild-text', { moodScore: 0.3, source: 'text' });

        expect(result.dominantSignal).toBe('text');
    });

    it('should compute dominantSignal as voice when all sources are voice', async () => {
        await updateServerState('guild-voice', { moodScore: 0.1, source: 'voice' });
        await updateServerState('guild-voice', { moodScore: 0.2, source: 'voice' });
        const result = await updateServerState('guild-voice', { moodScore: 0.3, source: 'voice' });

        expect(result.dominantSignal).toBe('voice');
    });

    it('should compute dominantSignal as mixed when sources vary', async () => {
        await updateServerState('guild-mixed', { moodScore: 0.1, source: 'text' });
        await updateServerState('guild-mixed', { moodScore: 0.2, source: 'voice' });
        const result = await updateServerState('guild-mixed', { moodScore: 0.3, source: 'text' });

        expect(result.dominantSignal).toBe('mixed');
    });

    it('should invalidate cache after update', async () => {
        // First get - populates cache
        const dbRow = {
            guild_id: 'guild-cache-test',
            mood_score: 0.5,
            mood_trend: 'stable',
            dominant_topics: '[]',
            open_commitments: '[]',
            last_voice_summary: null,
            last_voice_timestamp: null,
            source: 'text',
            dominant_signal: 'text',
            confidence: 0.5,
            updated_at: new Date(),
        };
        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);
        await getServerState('guild-cache-test');

        // Update - should invalidate cache
        mockConnection.query.mockResolvedValue([[], []]);
        await updateServerState('guild-cache-test', { moodScore: 0.8 });

        // Next get should hit DB again (cache invalidated)
        mockConnection.query.mockResolvedValueOnce([[{ ...dbRow, mood_score: 0.8 }], []]);
        await getServerState('guild-cache-test');

        // DB should have been called for: initial get, update, second get
        expect(mockConnection.query.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
});

// =========================================================================
// Context Markers Tests
// =========================================================================
describe('setContextMarker()', () => {
    it('should add a new context marker', async () => {
        mockConnection.query.mockResolvedValue([[], []]);

        const result = await setContextMarker('guild-marker', {
            type: 'high_stress_period',
            confidence: 0.8,
            topic: 'deadline',
        });

        expect(result.contextMarkers).toBeDefined();
        expect(result.contextMarkers.length).toBeGreaterThanOrEqual(1);

        const marker = result.contextMarkers.find(m => m.type === 'high_stress_period');
        expect(marker).toBeDefined();
        expect(marker.confidence).toBe(0.8);
        expect(marker.topic).toBe('deadline');
        expect(marker.expiresAt).toBeDefined();
    });

    it('should update existing marker of same type', async () => {
        // Mock state with an existing marker
        const existingMarker = { type: 'voice_tension', confidence: 0.6 };
        const dbRow = {
            guild_id: 'guild-dup',
            context_markers: JSON.stringify([existingMarker]),
            mood_score: 0,
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]); // getServerState returns existing marker
        mockConnection.query.mockResolvedValue([[], []]); // updateServerState success

        // Update existing marker
        const result = await setContextMarker('guild-dup', { type: 'voice_tension', confidence: 0.9 });

        // Should only have 1 marker of this type (updated)
        const markers = result.contextMarkers.filter(m => m.type === 'voice_tension');
        expect(markers.length).toBe(1);
        expect(markers[0].confidence).toBe(0.9);
    });

    it('should maintain source history buffer of size 3', async () => {
        // Clear history mock implicitly by using a fresh guild ID
        // Call update 4 times
        await updateServerState('guild-history-test', { source: 'text' });
        await updateServerState('guild-history-test', { source: 'text' });
        await updateServerState('guild-history-test', { source: 'text' });

        // 4th update with different source
        const result = await updateServerState('guild-history-test', { source: 'voice' });

        // if all text -> text. if all voice -> voice. else mixed
        expect(result.dominantSignal).toBe('mixed');
    });

    it('should use default confidence when not provided', async () => {
        mockConnection.query.mockResolvedValue([[], []]);

        const result = await setContextMarker('guild-default', { type: 'celebration' });

        const marker = result.contextMarkers.find(m => m.type === 'celebration');
        expect(marker.confidence).toBe(0.7); // Default
    });

    it('should respect custom ttlMs', async () => {
        mockConnection.query.mockResolvedValue([[], []]);

        const shortTtl = 5 * 60 * 1000; // 5 minutes
        const before = Date.now();

        const result = await setContextMarker('guild-ttl', {
            type: 'decision_pending',
            ttlMs: shortTtl,
        });

        const marker = result.contextMarkers.find(m => m.type === 'decision_pending');
        const expiresAt = new Date(marker.expiresAt).getTime();

        // Expiration should be ~5 minutes from now
        expect(expiresAt).toBeGreaterThanOrEqual(before + shortTtl - 1000);
        expect(expiresAt).toBeLessThanOrEqual(before + shortTtl + 1000);
    });
});

describe('getActiveContextMarkers()', () => {
    it('should return only non-expired markers', async () => {
        // Mock to return a row with context_markers that has both expired and active markers
        const expiredMarker = {
            type: 'old_marker',
            confidence: 0.5,
            expiresAt: new Date(Date.now() - 60000).toISOString(), // 1 min ago
        };
        const activeMarker = {
            type: 'active_marker',
            confidence: 0.8,
            expiresAt: new Date(Date.now() + 60000).toISOString(), // 1 min from now
        };

        const dbRow = {
            guild_id: 'guild-active-markers',
            mood_score: 0,
            mood_trend: 'stable',
            dominant_topics: '[]',
            open_commitments: '[]',
            context_markers: JSON.stringify([expiredMarker, activeMarker]),
            last_voice_summary: null,
            last_voice_timestamp: null,
            source: 'text',
            dominant_signal: 'text',
            confidence: 0.5,
            updated_at: new Date(),
        };

        // First query returns the row, subsequent queries for update
        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);
        mockConnection.query.mockResolvedValue([[], []]);

        const markers = await getActiveContextMarkers('guild-active-markers');

        expect(markers.length).toBe(1);
        expect(markers[0].type).toBe('active_marker');
    });

    it('should filter expired markers from state', async () => {
        const expiredMarker = {
            type: 'short_lived',
            confidence: 0.8,
            expiresAt: new Date(Date.now() - 1000).toISOString(), // expired
        };

        const dbRow = {
            guild_id: 'guild-expiry',
            mood_score: 0,
            mood_trend: 'stable',
            dominant_topics: '[]',
            open_commitments: '[]',
            context_markers: JSON.stringify([expiredMarker]),
            last_voice_summary: null,
            last_voice_timestamp: null,
            source: 'text',
            dominant_signal: 'text',
            confidence: 0.5,
            updated_at: new Date(),
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);
        mockConnection.query.mockResolvedValue([[], []]);

        const markers = await getActiveContextMarkers('guild-expiry');

        // Should be filtered out because it's expired
        expect(markers.length).toBe(0);
    });

    it('should return markers without expiresAt as always active', async () => {
        const noExpiryMarker = {
            type: 'permanent_marker',
            confidence: 0.9,
            // No expiresAt field - should always be active
        };

        const dbRow = {
            guild_id: 'guild-noexpiry',
            mood_score: 0,
            mood_trend: 'stable',
            dominant_topics: '[]',
            open_commitments: '[]',
            context_markers: JSON.stringify([noExpiryMarker]),
            last_voice_summary: null,
            last_voice_timestamp: null,
            source: 'text',
            dominant_signal: 'text',
            confidence: 0.5,
            updated_at: new Date(),
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);

        const markers = await getActiveContextMarkers('guild-noexpiry');

        expect(markers.length).toBe(1);
        expect(markers[0].type).toBe('permanent_marker');
    });
});

describe('clearContextMarker()', () => {
    it('should remove marker by type', async () => {
        const markers = [
            { type: 'keep_me', confidence: 0.5, expiresAt: new Date(Date.now() + 60000).toISOString() },
            { type: 'remove_me', confidence: 0.7, expiresAt: new Date(Date.now() + 60000).toISOString() },
        ];

        const dbRow = {
            guild_id: 'guild-clear',
            mood_score: 0,
            mood_trend: 'stable',
            dominant_topics: '[]',
            open_commitments: '[]',
            context_markers: JSON.stringify(markers),
            last_voice_summary: null,
            last_voice_timestamp: null,
            source: 'text',
            dominant_signal: 'text',
            confidence: 0.5,
            updated_at: new Date(),
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);
        mockConnection.query.mockResolvedValue([[], []]);

        const result = await clearContextMarker('guild-clear', 'remove_me');

        expect(result.contextMarkers.length).toBe(1);
        expect(result.contextMarkers[0].type).toBe('keep_me');
    });

    it('should return unchanged state if marker type not found', async () => {
        const markers = [
            { type: 'existing', confidence: 0.5, expiresAt: new Date(Date.now() + 60000).toISOString() },
        ];

        const dbRow = {
            guild_id: 'guild-notfound',
            mood_score: 0,
            mood_trend: 'stable',
            dominant_topics: '[]',
            open_commitments: '[]',
            context_markers: JSON.stringify(markers),
            last_voice_summary: null,
            last_voice_timestamp: null,
            source: 'text',
            dominant_signal: 'text',
            confidence: 0.5,
            updated_at: new Date(),
        };

        mockConnection.query.mockResolvedValueOnce([[dbRow], []]);

        const result = await clearContextMarker('guild-notfound', 'nonexistent');

        // State should be returned unchanged (no update since nothing was removed)
        expect(result.contextMarkers).toBeDefined();
        expect(result.contextMarkers.length).toBe(1);
        expect(result.contextMarkers[0].type).toBe('existing');
    });
});

// =========================================================================
// TRIGGERS Constants Tests
// =========================================================================
describe('TRIGGERS constants', () => {
    it('should have MOOD_NEGATIVE threshold at -0.5', () => {
        expect(TRIGGERS.MOOD_NEGATIVE).toBe(-0.5);
    });

    it('should have MOOD_POSITIVE threshold at 0.7', () => {
        expect(TRIGGERS.MOOD_POSITIVE).toBe(0.7);
    });
});

// =========================================================================
// VOICE_EXPIRATION_MS Constant Tests
// =========================================================================
describe('Voice expiration', () => {
    it('should expire voice summaries after 10 minutes', () => {
        expect(VOICE_EXPIRATION_MS).toBe(10 * 60 * 1000);
    });
});


// =========================================================================
// Edge Cases and Robustness Tests
// =========================================================================
describe('ServerState Edge Cases', () => {
    beforeEach(() => {
        resetAllMocks();
        jest.clearAllMocks();
    });

    // Tests for keyword detection removed (logic moved to voiceSessionManager)

    it('should not trigger on similar but non-matching words', () => {
        const state = createMockState({
            lastVoiceSummary: 'Talking about celery stalks in cooking',
        });

        const triggers = checkTriggers(state);
        expect(triggers).not.toContain('HELP_REQUEST');
        expect(triggers).toContain('voice_activity');
    });

    it('should handle extremely negative mood scores', () => {
        const state = createMockState({
            moodScore: -1.0,
            moodTrend: 'falling',
        });

        const triggers = checkTriggers(state);
        expect(triggers).toContain('mood_negative');
    });

    it('should handle extremely positive mood scores', () => {
        const state = createMockState({
            moodScore: 1.0,
            moodTrend: 'rising',
        });

        const triggers = checkTriggers(state);
        expect(triggers).toContain('mood_positive');
    });

    it('should handle undefined state fields', () => {
        /** @type {any} */
        const state = {
            moodScore: undefined,
            lastVoiceSummary: undefined,
            recentEvents: undefined,
        };

        // Should not throw
        const triggers = checkTriggers(state);
        expect(triggers).toEqual([]);
    });
});
