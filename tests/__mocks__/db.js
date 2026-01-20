// Mock database module for testing
// Provides in-memory mock of MySQL pool

const mockConnection = {
    query: jest.fn().mockResolvedValue([[], []]),
    execute: jest.fn().mockResolvedValue([[], []]),
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn(),
};

const pool = {
    getConnection: jest.fn().mockResolvedValue(mockConnection),
    query: jest.fn().mockResolvedValue([[], []]),
    execute: jest.fn().mockResolvedValue([[], []]),
};

// Helper to reset all mocks between tests
function resetMocks() {
    mockConnection.query.mockReset().mockResolvedValue([[], []]);
    mockConnection.execute.mockReset().mockResolvedValue([[], []]);
    mockConnection.beginTransaction.mockReset().mockResolvedValue(undefined);
    mockConnection.commit.mockReset().mockResolvedValue(undefined);
    mockConnection.rollback.mockReset().mockResolvedValue(undefined);
    mockConnection.release.mockReset();
    pool.getConnection.mockReset().mockResolvedValue(mockConnection);
    pool.query.mockReset().mockResolvedValue([[], []]);
    pool.execute.mockReset().mockResolvedValue([[], []]);
}

// Helper to set up specific query responses
function mockQueryResponse(response) {
    mockConnection.query.mockResolvedValueOnce([response, []]);
}

module.exports = {
    pool,
    mockConnection,
    resetMocks,
    mockQueryResponse,
};
