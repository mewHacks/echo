// admin-tool.js
const { actionsConfig } = require('./actions-config');
const { memoryToolDeclarations } = require('./core/memory-tools');

// Generate tool declarations from central config (exclude execute function)
const adminFunctionDeclarations = Object.entries(actionsConfig).map(([name, config]) => ({
  name,
  description: config.description,
  parameters: config.parameters,
}));

// Extract permissions for permission gating
const functionPermissions = {};
Object.entries(actionsConfig).forEach(([name, config]) => {
  if (config.permission) {
    functionPermissions[name] = config.permission;
  }
});

const searchTool = [
  { googleSearch: {} },
];

const adminTools = [
  { functionDeclarations: adminFunctionDeclarations },
];

// Memory tools for on-demand context retrieval
const memoryTools = [
  { functionDeclarations: memoryToolDeclarations },
];

module.exports = {
  searchTool,
  adminTools,
  memoryTools,
  functionPermissions,
};