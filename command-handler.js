// command-handler.js
const { actionsConfig } = require('./actions-config');

async function executeFunctionCall(name, args, context) {
  const action = actionsConfig[name];
  
  if (!action) {
    return "Error: Action not found.";
  }

  try {
    return await action.execute(args, context);
  } catch (err) {
    return `Execution error: ${err.message}`;
  }
}

module.exports = { executeFunctionCall };