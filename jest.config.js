module.exports = {
    testEnvironment: 'node',
    testMatch: ['**/tests/**/*.test.js'],
    collectCoverageFrom: [
        'core/**/*.js',
        '!core/memory-tools.js', // Depends on heavy Discord context
    ],
    coverageDirectory: 'coverage',
    moduleNameMapper: {
        // Map module imports to mocks (handles both test file imports and core module imports)
        '^(\\.\\./)*db$': '<rootDir>/tests/__mocks__/db.js',
        '^(\\.\\./)*gemini-client$': '<rootDir>/tests/__mocks__/gemini-client.js',
        '^(\\.\\./)*discord-client$': '<rootDir>/tests/__mocks__/discord-client.js',
        '^(\\.\\./)*utils/debugging$': '<rootDir>/tests/__mocks__/utils/debugging.js',
        '^(\\.\\./)*config/models$': '<rootDir>/tests/__mocks__/config/models.js',
    },
    setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
    verbose: true,
};
