const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

/**
 * Loads every route module inside the /api directory (except this file) and
 * mounts them on a shared Express router. Each module should export either
 * a function (router, context) => void or an object with a register() method.
 *
 * @param {object} context Additional context shared with routes (e.g., Discord client)
 * @returns {import('express').Router}
 */
function buildApiRouter(context = {}) {
  const router = express.Router();
  const apiDir = __dirname;
  const files = fs.readdirSync(apiDir).filter((file) => file.endsWith('.js') && file !== 'index.js');

  for (const file of files) {
    const filePath = path.join(apiDir, file);
    try {
      const routeModule = require(filePath);
      if (typeof routeModule === 'function') {
        routeModule(router, context);
      } else if (routeModule && typeof routeModule.register === 'function') {
        routeModule.register(router, context);
      } else {
        console.warn(`[API] ${file} is missing an exported function or register() method.`);
      }
    } catch (error) {
      console.error(`[API] Failed to load ${file}:`, error);
    }
  }

  return router;
}

module.exports = {
  buildApiRouter,
};
