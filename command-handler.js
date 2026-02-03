const { actionsConfig } = require('./actions-config');
const { getGeminiClient } = require('./gemini-client');
const { executeMemoryTool } = require('./core/memory-tools');

async function executeFunctionCall(name, args, context) {
  // Handle web search - single call only
  if (name === 'web_search') {
    try {
      const ai = getGeminiClient();
      const result = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        config: {
          tools: [{ googleSearch: {} }]
        },
        contents: [{ role: 'user', parts: [{ text: args.query }] }]
      });

      return result.candidates[0]?.content?.parts?.find(p => p.text)?.text || 'Search completed.';
    } catch (err) {
      return `Search failed: ${err.message}`;
    }
  }

  // Handle Memory Tools
  const memoryToolNames = ['search_channel_history', 'get_channel_summary', 'get_server_state'];
  if (memoryToolNames.includes(name)) {
    try {
      // Memory tools need guild ID context
      if (!context.guild) return "Error: Memory tools generally require a server context.";

      const result = await executeMemoryTool(name, context.guild.id, args);
      return JSON.stringify(result);
    } catch (err) {
      return `Memory Tool Error: ${err.message}`;
    }
  }

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