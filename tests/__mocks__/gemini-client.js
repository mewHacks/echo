// Mock Gemini client for testing
// Allows tests to control AI responses

let mockResponse = {
    text: JSON.stringify({
        topics: [{ topic: 'testing', weight: 0.8 }],
        sentiment: { avg: 0.0, min: -0.2, negative_ratio: 0.1 },
        events: []
    })
};

const mockGenerateContent = jest.fn().mockImplementation(async () => mockResponse);

const mockClient = {
    models: {
        generateContent: mockGenerateContent,
    },
};

function getGeminiClient() {
    return mockClient;
}

// Helper to set mock response
function setMockResponse(response) {
    if (typeof response === 'object') {
        mockResponse = { text: JSON.stringify(response) };
    } else {
        mockResponse = { text: response };
    }
    mockGenerateContent.mockImplementation(async () => mockResponse);
}

// Helper to set raw text response (for testing parse errors)
function setMockRawResponse(text) {
    mockResponse = { text };
    mockGenerateContent.mockImplementation(async () => mockResponse);
}

// Helper to make Gemini throw an error
function setMockError(error) {
    mockGenerateContent.mockRejectedValueOnce(error);
}

// Helper to reset mocks
function resetMocks() {
    mockGenerateContent.mockReset();
    mockResponse = {
        text: JSON.stringify({
            topics: [],
            sentiment: { avg: 0, min: 0, negative_ratio: 0 },
            events: []
        })
    };
    mockGenerateContent.mockImplementation(async () => mockResponse);
}

module.exports = {
    getGeminiClient,
    setMockResponse,
    setMockRawResponse,
    setMockError,
    resetMocks,
    mockGenerateContent,
};
