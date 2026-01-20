// Jest setup file
// Runs before each test file

// Suppress console output during tests (cleaner test output)
// Comment out these lines if you need to debug tests
beforeAll(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
    console.log.mockRestore?.();
    console.warn.mockRestore?.();
    console.error.mockRestore?.();
});

// Reset module registry between tests to ensure clean state
afterEach(() => {
    jest.clearAllMocks();
});
