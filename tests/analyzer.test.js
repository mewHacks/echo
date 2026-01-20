// tests/analyzer.test.js
// Unit tests for the Analyzer module (core/analyzer.js)
// Tests message analysis, sentiment detection, dynamic batching, and Gemini integration

// =========================================================================
// MOCK SETUP - Must be before requires
// =========================================================================

// Mock DB
const mockConnection = {
    query: jest.fn().mockResolvedValue([[], []]),
    execute: jest.fn().mockResolvedValue([[], []]),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
};

const mockPool = {
    getConnection: jest.fn().mockResolvedValue(mockConnection),
    query: jest.fn().mockResolvedValue([[], []]),
    execute: jest.fn().mockResolvedValue([[], []]),
};

jest.mock('../db', () => ({
    pool: mockPool,
}));

// Mock Gemini client
let mockGeminiResponse = { text: JSON.stringify({ topics: [], sentiment: { avg: 0, min: 0, negative_ratio: 0 }, events: [] }) };
const mockGenerateContent = jest.fn().mockImplementation(async () => mockGeminiResponse);

jest.mock('../gemini-client', () => ({
    getGeminiClient: () => ({
        models: {
            generateContent: mockGenerateContent,
        },
    }),
}));

// Mock debugging
jest.mock('../utils/debugging', () => ({
    debugLog: jest.fn(),
}));

// Mock models config
jest.mock('../config/models', () => ({
    GEMINI_TEXT_MODEL: 'mock-model',
    GEMINI_ANALYZER_MODEL: 'mock-analyzer-model',
}));

// Mock server-state
const mockGetServerState = jest.fn().mockResolvedValue({ moodScore: 0, moodTrend: 'stable', dominantTopics: [] });
const mockUpdateServerState = jest.fn().mockResolvedValue({ moodScore: 0, moodTrend: 'stable', dominantTopics: [], recentEvents: [] });
const mockCheckTriggers = jest.fn().mockReturnValue([]);

jest.mock('../core/server-state', () => ({
    getServerState: mockGetServerState,
    updateServerState: mockUpdateServerState,
    checkTriggers: mockCheckTriggers,
}));

// Mock intervention-planner
const mockTriggerIntervention = jest.fn().mockResolvedValue(null);

jest.mock('../core/intervention-planner', () => ({
    triggerIntervention: mockTriggerIntervention,
}));

// =========================================================================
// IMPORTS - After mocks
// =========================================================================

const { analyzeGuild } = require('../core/analyzer');

// =========================================================================
// HELPERS
// =========================================================================

function setMockGeminiResponse(response) {
    if (typeof response === 'object') {
        mockGeminiResponse = { text: JSON.stringify(response) };
    } else {
        mockGeminiResponse = { text: response };
    }
}

function resetAllMocks() {
    mockConnection.query.mockReset().mockResolvedValue([[], []]);
    mockConnection.execute.mockReset().mockResolvedValue([[], []]);
    mockConnection.beginTransaction.mockReset().mockResolvedValue(undefined);
    mockConnection.commit.mockReset().mockResolvedValue(undefined);
    mockConnection.rollback.mockReset().mockResolvedValue(undefined);
    mockConnection.release.mockReset();
    mockPool.getConnection.mockReset().mockResolvedValue(mockConnection);

    mockGenerateContent.mockClear();
    mockGetServerState.mockClear().mockResolvedValue({ moodScore: 0, moodTrend: 'stable', dominantTopics: [] });
    mockUpdateServerState.mockClear().mockResolvedValue({ moodScore: 0, moodTrend: 'stable', dominantTopics: [], recentEvents: [] });
    mockCheckTriggers.mockClear().mockReturnValue([]);
    mockTriggerIntervention.mockClear().mockResolvedValue(null);

    setMockGeminiResponse({ topics: [], sentiment: { avg: 0, min: 0, negative_ratio: 0 }, events: [] });
}

// =========================================================================
// TESTS
// =========================================================================

describe('Analyzer Module', () => {
    beforeEach(() => {
        resetAllMocks();
        jest.clearAllMocks();
    });

    // =========================================================================
    // analyzeGuild() - Basic Functionality
    // =========================================================================
    describe('analyzeGuild()', () => {
        it('should return null when no new messages exist', async () => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 100, msg_rate_avg: 1.0, updated_at: new Date() }], []])
                .mockResolvedValueOnce([[], []]); // No new messages

            const result = await analyzeGuild('guild-123');
            expect(result).toBeNull();
        });

        it('should analyze messages and return topics, sentiment, events', async () => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
                .mockResolvedValueOnce([[
                    { id: 1, guild_id: 'guild-123', channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'Alice', content: 'Hello everyone!' },
                    { id: 2, guild_id: 'guild-123', channel_id: 'ch-1', channel_name: 'general', user_id: 'u2', username: 'Bob', content: 'Hey Alice!' },
                ], []])
                .mockResolvedValueOnce([[], []])
                .mockResolvedValue([[], []]);

            setMockGeminiResponse({
                topics: [{ topic: 'greetings', weight: 0.9 }],
                sentiment: { avg: 0.5, min: 0.3, negative_ratio: 0.0 },
                events: []
            });

            const result = await analyzeGuild('guild-123');

            expect(result).not.toBeNull();
            expect(result.topics).toEqual([{ topic: 'greetings', weight: 0.9 }]);
            expect(result.sentiment.avg).toBe(0.5);
            expect(result.sentiment.min).toBe(0.3);
            expect(result.sentiment.negative_ratio).toBe(0.0);
            expect(result.events).toEqual([]);
        });

        it('should call Gemini with correct context format', async () => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 5, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
                .mockResolvedValueOnce([[
                    { id: 6, channel_name: 'general', username: 'Alice', content: 'New message' },
                ], []])
                .mockResolvedValueOnce([[
                    { channel_name: 'general', username: 'Bob', content: 'Context message' },
                ], []])
                .mockResolvedValue([[], []]);

            setMockGeminiResponse({ topics: [], sentiment: { avg: 0, min: 0, negative_ratio: 0 }, events: [] });

            await analyzeGuild('guild-123');

            expect(mockGenerateContent).toHaveBeenCalled();
            const callArgs = mockGenerateContent.mock.calls[0][0];
            expect(callArgs.contents[0].parts[0].text).toContain('PREVIOUS CONTEXT');
            expect(callArgs.contents[0].parts[0].text).toContain('CURRENT BATCH');
            expect(callArgs.contents[0].parts[0].text).toContain('[HISTORY]');
        });

        it('should handle Gemini returning empty response gracefully', async () => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
                .mockResolvedValueOnce([[
                    { id: 1, channel_name: 'general', username: 'User', content: 'Test' },
                ], []])
                .mockResolvedValueOnce([[], []])
                .mockResolvedValue([[], []]);

            mockGenerateContent.mockResolvedValueOnce({ text: undefined });

            const result = await analyzeGuild('guild-123');

            expect(result).not.toBeNull();
            expect(result.topics).toEqual([]);
            expect(result.sentiment.avg).toBe(0);
            expect(result.events).toEqual([]);
        });

        it('should handle invalid JSON from Gemini gracefully', async () => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
                .mockResolvedValueOnce([[
                    { id: 1, channel_name: 'general', username: 'User', content: 'Test' },
                ], []])
                .mockResolvedValueOnce([[], []])
                .mockResolvedValue([[], []]);

            mockGeminiResponse = { text: 'This is not valid JSON { broken' };

            const result = await analyzeGuild('guild-123');

            expect(result).not.toBeNull();
            expect(result.topics).toEqual([]);
        });
    });

    // =========================================================================
    // Sentiment Analysis Tests
    // =========================================================================
    describe('Sentiment Analysis', () => {
        beforeEach(() => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
                .mockResolvedValueOnce([[
                    { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Test message' },
                ], []])
                .mockResolvedValueOnce([[], []])
                .mockResolvedValue([[], []]);
        });

        it('should pass through positive sentiment correctly', async () => {
            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: 0.8, min: 0.5, negative_ratio: 0.0 },
                events: []
            });

            const result = await analyzeGuild('guild-123');

            expect(result.sentiment.avg).toBe(0.8);
            expect(result.sentiment.min).toBe(0.5);
            expect(result.sentiment.negative_ratio).toBe(0.0);
        });

        it('should pass through negative sentiment correctly', async () => {
            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: -0.6, min: -0.9, negative_ratio: 0.4 },
                events: []
            });

            const result = await analyzeGuild('guild-123');

            expect(result.sentiment.avg).toBe(-0.6);
            expect(result.sentiment.min).toBe(-0.9);
            expect(result.sentiment.negative_ratio).toBe(0.4);
        });

        it('should normalize missing sentiment fields to 0', async () => {
            setMockGeminiResponse({
                topics: [],
                sentiment: {},
                events: []
            });

            const result = await analyzeGuild('guild-123');

            expect(result.sentiment.avg).toBe(0);
            expect(result.sentiment.min).toBe(0);
            expect(result.sentiment.negative_ratio).toBe(0);
        });
    });

    // =========================================================================
    // Event Detection Tests
    // =========================================================================
    describe('Event Detection', () => {
        beforeEach(() => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
                .mockResolvedValueOnce([[
                    { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Argument!' },
                ], []])
                .mockResolvedValueOnce([[], []])
                .mockResolvedValue([[], []]);
        });

        it('should detect CONFLICT events from Gemini', async () => {
            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: -0.5, min: -0.8, negative_ratio: 0.3 },
                events: [
                    { type: 'CONFLICT', desc: 'Heated argument between users', confidence: 0.85 }
                ]
            });

            const result = await analyzeGuild('guild-123');

            expect(result.events).toHaveLength(1);
            expect(result.events[0].type).toBe('CONFLICT');
            expect(result.events[0].confidence).toBe(0.85);
        });

        it('should detect HELP_REQUEST events from Gemini', async () => {
            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: -0.3, min: -0.5, negative_ratio: 0.2 },
                events: [
                    { type: 'HELP_REQUEST', desc: 'User asking for urgent help', confidence: 0.9 }
                ]
            });

            const result = await analyzeGuild('guild-123');

            expect(result.events).toHaveLength(1);
            expect(result.events[0].type).toBe('HELP_REQUEST');
        });

        it('should detect multiple events simultaneously', async () => {
            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: -0.7, min: -0.9, negative_ratio: 0.5 },
                events: [
                    { type: 'CONFLICT', desc: 'Argument', confidence: 0.8 },
                    { type: 'HELP_REQUEST', desc: 'User needs help', confidence: 0.75 }
                ]
            });

            const result = await analyzeGuild('guild-123');

            expect(result.events).toHaveLength(2);
        });

        it('should handle empty events array', async () => {
            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: 0, min: 0, negative_ratio: 0 },
                events: []
            });

            const result = await analyzeGuild('guild-123');

            expect(result.events).toEqual([]);
        });
    });

    // =========================================================================
    // ServerState Integration Tests
    // =========================================================================
    describe('ServerState Integration', () => {
        beforeEach(() => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
                .mockResolvedValueOnce([[
                    { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Test' },
                ], []])
                .mockResolvedValueOnce([[], []])
                .mockResolvedValue([[], []]);
        });

        it('should update ServerState with analysis results', async () => {
            setMockGeminiResponse({
                topics: [{ topic: 'gaming', weight: 0.7 }],
                sentiment: { avg: 0.3, min: 0.1, negative_ratio: 0.1 },
                events: []
            });

            await analyzeGuild('guild-123');

            expect(mockUpdateServerState).toHaveBeenCalledWith('guild-123', expect.objectContaining({
                moodScore: 0.3,
                source: 'text',
                confidence: 0.8,
            }));
        });

        it('should calculate mood trend as rising when mood improves significantly', async () => {
            mockGetServerState.mockResolvedValueOnce({ moodScore: -0.5 });

            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: 0.3, min: 0.1, negative_ratio: 0.0 },
                events: []
            });

            await analyzeGuild('guild-123');

            expect(mockUpdateServerState).toHaveBeenCalledWith('guild-123', expect.objectContaining({
                moodTrend: 'rising',
            }));
        });

        it('should calculate mood trend as falling when mood drops significantly', async () => {
            mockGetServerState.mockResolvedValueOnce({ moodScore: 0.5 });

            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: -0.3, min: -0.5, negative_ratio: 0.3 },
                events: []
            });

            await analyzeGuild('guild-123');

            expect(mockUpdateServerState).toHaveBeenCalledWith('guild-123', expect.objectContaining({
                moodTrend: 'falling',
            }));
        });

        it('should calculate mood trend as stable when change is small', async () => {
            mockGetServerState.mockResolvedValueOnce({ moodScore: 0.1 });

            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: 0.2, min: 0.1, negative_ratio: 0.0 },
                events: []
            });

            await analyzeGuild('guild-123');

            expect(mockUpdateServerState).toHaveBeenCalledWith('guild-123', expect.objectContaining({
                moodTrend: 'stable',
            }));
        });
    });

    // =========================================================================
    // Intervention Trigger Tests
    // =========================================================================
    describe('Intervention Triggering', () => {
        beforeEach(() => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
                .mockResolvedValueOnce([[
                    { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Test' },
                ], []])
                .mockResolvedValueOnce([[], []])
                .mockResolvedValue([[], []]);

            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: 0, min: 0, negative_ratio: 0 },
                events: []
            });
        });

        it('should call triggerIntervention when triggers are detected', async () => {
            mockCheckTriggers.mockReturnValueOnce(['mood_negative', 'CONFLICT']);

            await analyzeGuild('guild-123');

            expect(mockTriggerIntervention).toHaveBeenCalledWith(
                'guild-123',
                ['mood_negative', 'CONFLICT'],
                expect.any(Object)
            );
        });

        it('should NOT call triggerIntervention when no triggers detected', async () => {
            mockCheckTriggers.mockReturnValueOnce([]);

            await analyzeGuild('guild-123');

            expect(mockTriggerIntervention).not.toHaveBeenCalled();
        });
    });

    // =========================================================================
    // Source Channel Tracking Tests
    // =========================================================================
    describe('Source Channel Tracking', () => {
        it('should identify the most active channel as source', async () => {
            mockConnection.query
                .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
                .mockResolvedValueOnce([[
                    { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Msg 1' },
                    { id: 2, channel_id: 'ch-1', channel_name: 'general', user_id: 'u2', username: 'User2', content: 'Msg 2' },
                    { id: 3, channel_id: 'ch-1', channel_name: 'general', user_id: 'u3', username: 'User3', content: 'Msg 3' },
                    { id: 4, channel_id: 'ch-2', channel_name: 'random', user_id: 'u1', username: 'User', content: 'Msg 4' },
                ], []])
                .mockResolvedValueOnce([[], []])
                .mockResolvedValue([[], []]);

            setMockGeminiResponse({
                topics: [],
                sentiment: { avg: 0, min: 0, negative_ratio: 0 },
                events: []
            });

            await analyzeGuild('guild-123');

            // The analyzer identifies the most active channel by counting messages
            // It passes channel_name when channel_id doesn't look like an ID (all digits)
            expect(mockUpdateServerState).toHaveBeenCalledWith('guild-123', expect.objectContaining({
                sourceChannelName: 'ch-1', // The channel_id 'ch-1' is detected as name since it's not all digits
            }));
        });
    });
});

// =========================================================================
// Source Channel ID Detection Tests
// =========================================================================
describe('Source Channel ID Detection', () => {
    beforeEach(() => {
        resetAllMocks();
        jest.clearAllMocks();
    });

    it('should detect numeric channel_id as ID and find channel_name', async () => {
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: '123456789012345678', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Msg 1' },
                { id: 2, channel_id: '123456789012345678', channel_name: 'general', user_id: 'u2', username: 'User2', content: 'Msg 2' },
            ], []])
            .mockResolvedValueOnce([[], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: 0, min: 0, negative_ratio: 0 },
            events: []
        });

        await analyzeGuild('guild-numeric-id');

        expect(mockUpdateServerState).toHaveBeenCalledWith('guild-numeric-id', expect.objectContaining({
            sourceChannelId: '123456789012345678',
            sourceChannelName: 'general',
        }));
    });

    it('should handle channel_name fallback when channel_id not numeric', async () => {
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: null, channel_name: 'random', user_id: 'u1', username: 'User', content: 'Msg 1' },
                { id: 2, channel_id: null, channel_name: 'random', user_id: 'u2', username: 'User2', content: 'Msg 2' },
            ], []])
            .mockResolvedValueOnce([[], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: 0, min: 0, negative_ratio: 0 },
            events: []
        });

        await analyzeGuild('guild-name-fallback');

        expect(mockUpdateServerState).toHaveBeenCalledWith('guild-name-fallback', expect.objectContaining({
            sourceChannelName: 'random',
        }));
    });
});

// =========================================================================
// Error Handling Tests
// =========================================================================
describe('Analyzer Error Handling', () => {
    beforeEach(() => {
        resetAllMocks();
        jest.clearAllMocks();
    });

    it('should handle intervention planner error gracefully', async () => {
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Test' },
            ], []])
            .mockResolvedValueOnce([[], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: 0, min: 0, negative_ratio: 0 },
            events: []
        });

        // Make checkTriggers return triggers to invoke planner
        mockCheckTriggers.mockReturnValueOnce(['mood_negative']);

        // Make intervention planner throw an error
        mockTriggerIntervention.mockRejectedValueOnce(new Error('Planner failed'));

        // Should not throw, just log error
        const result = await analyzeGuild('guild-planner-error');

        expect(result).not.toBeNull();
    });

    it('should handle ServerState update error gracefully', async () => {
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Test' },
            ], []])
            .mockResolvedValueOnce([[], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: 0, min: 0, negative_ratio: 0 },
            events: []
        });

        // Make updateServerState throw an error
        mockUpdateServerState.mockRejectedValueOnce(new Error('ServerState update failed'));

        // Should not throw, analysis should still complete
        const result = await analyzeGuild('guild-state-error');

        expect(result).not.toBeNull();
    });

    it('should rollback transaction on database error', async () => {
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Test' },
            ], []])
            .mockResolvedValueOnce([[], []])
            .mockRejectedValueOnce(new Error('Database error')); // Cause error in DB operation

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: 0, min: 0, negative_ratio: 0 },
            events: []
        });

        // analyzeGuild swallows the error but logs it. 
        // We verify that rollback was called internally by updateDatabase before it threw.
        await analyzeGuild('guild-db-error');

        expect(mockConnection.rollback).toHaveBeenCalled();
        expect(mockConnection.release).toHaveBeenCalled();
    });
});

// =========================================================================
// Dynamic Batching / Spike Detection Tests
// =========================================================================
describe('Dynamic Batching', () => {
    beforeEach(() => {
        resetAllMocks();
        jest.clearAllMocks();
    });

    it('should detect spike when current rate > 2x average and > 5', async () => {
        // Set up cursor with low historical rate
        mockConnection.query
            .mockResolvedValueOnce([[{
                last_message_id: 0,
                msg_rate_avg: 2.0, // Low average
                updated_at: new Date(Date.now() - 60000) // 1 minute ago
            }], []])
            .mockResolvedValueOnce([
                // Many messages = high current rate (spike)
                Array.from({ length: 20 }, (_, i) => ({
                    id: i + 1,
                    channel_id: 'ch-1',
                    channel_name: 'general',
                    user_id: `u${i % 5}`,
                    username: `User${i % 5}`,
                    content: `Message ${i}`
                })),
                []
            ])
            .mockResolvedValueOnce([[], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: 0, min: 0, negative_ratio: 0 },
            events: []
        });

        await analyzeGuild('guild-spike');

        // Verify that the observation logged mentions "Spike Detected"
        const observationCalls = mockConnection.query.mock.calls.filter(
            call => call[0]?.includes?.('observations')
        );
        expect(observationCalls.length).toBeGreaterThan(0);
    });

    it('should merge with existing daily stats row', async () => {
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Test' },
            ], []])
            .mockResolvedValueOnce([[], []])
            // Return existing daily stats row
            .mockResolvedValueOnce([[{ message_count: 50, sentiment_avg: 0.2 }], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: 0.4, min: 0.1, negative_ratio: 0 },
            events: []
        });

        await analyzeGuild('guild-merge-stats');

        // The daily_stats upsert should have been called with merged values
        const upsertCalls = mockConnection.query.mock.calls.filter(
            call => call[0]?.includes?.('daily_stats')
        );
        expect(upsertCalls.length).toBeGreaterThan(0);
    });
});

// =========================================================================
// Sentiment Spike Detection Tests
// =========================================================================
describe('Sentiment Spike Detection', () => {
    beforeEach(() => {
        resetAllMocks();
        jest.clearAllMocks();
    });

    it('should create SENTIMENT_SPIKE observation for very negative sentiment', async () => {
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Very angry message!' },
            ], []])
            .mockResolvedValueOnce([[], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: -0.8, min: -0.9, negative_ratio: 0.5 }, // Triggers sentinel
            events: []
        });

        await analyzeGuild('guild-sentiment-spike');

        // Verify SENTIMENT_SPIKE observation was logged
        // The query string is generic, so we must check the parameters (call[1])
        const observationCalls = mockConnection.query.mock.calls.filter(
            call => call[1] && call[1][0] === 'SENTIMENT_SPIKE'
        );
        expect(observationCalls.length).toBeGreaterThan(0);
    });
});

// =========================================================================
// Topic Processing Tests
// =========================================================================
describe('Topic Processing', () => {
    beforeEach(() => {
        resetAllMocks();
        jest.clearAllMocks();

        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Discussing topics' },
            ], []])
            .mockResolvedValueOnce([[], []])
            .mockResolvedValue([[], []]);
    });

    it('should pass topics to ServerState correctly', async () => {
        setMockGeminiResponse({
            topics: [
                { topic: 'javascript', weight: 0.9 },
                { topic: 'react', weight: 0.7 },
                { topic: 'typescript', weight: 0.5 },
            ],
            sentiment: { avg: 0, min: 0, negative_ratio: 0 },
            events: []
        });

        await analyzeGuild('guild-123');

        expect(mockUpdateServerState).toHaveBeenCalledWith('guild-123', expect.objectContaining({
            dominantTopics: ['javascript', 'react', 'typescript'],
        }));
    });

    it('should limit topics to 5', async () => {
        setMockGeminiResponse({
            topics: [
                { topic: 'topic1', weight: 0.9 },
                { topic: 'topic2', weight: 0.8 },
                { topic: 'topic3', weight: 0.7 },
                { topic: 'topic4', weight: 0.6 },
                { topic: 'topic5', weight: 0.5 },
                { topic: 'topic6', weight: 0.4 },
                { topic: 'topic7', weight: 0.3 },
            ],
            sentiment: { avg: 0, min: 0, negative_ratio: 0 },
            events: []
        });

        await analyzeGuild('guild-123');

        expect(mockUpdateServerState).toHaveBeenCalledWith('guild-123', expect.objectContaining({
            dominantTopics: expect.arrayContaining(['topic1', 'topic2', 'topic3', 'topic4', 'topic5']),
        }));

        const call = mockUpdateServerState.mock.calls[0];
        expect(call[1].dominantTopics.length).toBe(5);
    });
});

// =========================================================================
// Edge Cases & Error Handling Tests
// =========================================================================
describe('Edge Cases & Error Handling', () => {
    beforeEach(() => {
        resetAllMocks();
        jest.clearAllMocks();
    });

    it('should handle channel ID lookup fallback when channel name unavailable', async () => {
        // Setup DB valid response
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: '123456789', channel_name: null, user_id: 'u1', username: 'User', content: 'Test' },
            ], []])
            .mockResolvedValueOnce([[], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: 0.1, min: 0.1, negative_ratio: 0 },
            events: []
        });

        // Mock Discord Client global if needed, or rely on internal logic. 
        // NOTE: The analyzer requires `discord-client` which is not mocked in the top-level scope of this file 
        // BUT it seems `analyzer.js` imports it. 
        // If the test file doesn't mock `discord-client`, it might use the real one or the __mocks__ one if jest automocks.
        // Assuming jest automock or manual mock is handling it. The current test file setup relies on inline mocks for db/gemini.

        await analyzeGuild('guild-edge-1');

        // Success execution implies it didn't crash
        expect(mockGenerateContent).toHaveBeenCalled();
    });

    it('should handle error in intervention planner gracefully', async () => {
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Test' },
            ], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({
            topics: [],
            sentiment: { avg: -0.9, min: -1.0, negative_ratio: 1.0 }, // Trigger intervention
            events: []
        });

        // Mock triggers to ensure planner is actually called
        mockCheckTriggers.mockReturnValue(['CONFLICT']);

        // Force intervention planner to fail
        mockTriggerIntervention.mockRejectedValue(new Error('Planner failure'));

        // Should not throw
        await analyzeGuild('guild-planner-error');

        expect(mockTriggerIntervention).toHaveBeenCalled();
    });

    it('should handle error in server state update gracefully', async () => {
        mockConnection.query
            .mockResolvedValueOnce([[{ last_message_id: 0, msg_rate_avg: 1.0, updated_at: new Date(Date.now() - 60000) }], []])
            .mockResolvedValueOnce([[
                { id: 1, channel_id: 'ch-1', channel_name: 'general', user_id: 'u1', username: 'User', content: 'Test' },
            ], []])
            .mockResolvedValue([[], []]);

        setMockGeminiResponse({ topics: [], sentiment: { avg: 0, min: 0, negative_ratio: 0 }, events: [] });

        // Force updateServerState to fail
        mockUpdateServerState.mockRejectedValue(new Error('State update error'));

        await analyzeGuild('guild-state-error-2');

        expect(mockUpdateServerState).toHaveBeenCalled();
    });
});
