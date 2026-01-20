// Mock debugging utilities
// Silences debug output during tests

const debugLog = jest.fn();

module.exports = {
    debugLog,
};
