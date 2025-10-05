/**
 * Configuration management for Figma Console MCP server
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ServerConfig } from './types/index.js';

/**
 * Default configuration values
 */
const DEFAULT_CONFIG: ServerConfig = {
  browser: {
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--no-sandbox', // Note: Only use in trusted environments
    ],
  },
  console: {
    bufferSize: 1000,
    filterLevels: ['log', 'info', 'warn', 'error', 'debug'],
    truncation: {
      maxStringLength: 500,
      maxArrayLength: 10,
      maxObjectDepth: 3,
      removeDuplicates: true,
    },
  },
  screenshots: {
    defaultFormat: 'png',
    quality: 90,
    storePath: join(process.env.TMPDIR || '/tmp', 'figma-console-mcp', 'screenshots'),
  },
};

/**
 * Possible config file locations (checked in order)
 */
const CONFIG_PATHS = [
  // Environment variable override
  process.env.FIGMA_CONSOLE_CONFIG,
  // Project-local config
  join(process.cwd(), '.figma-console-mcp.json'),
  join(process.cwd(), 'figma-console-mcp.json'),
  // User home config
  join(homedir(), '.config', 'figma-console-mcp', 'config.json'),
  join(homedir(), '.figma-console-mcp.json'),
].filter((path): path is string => path !== undefined);

/**
 * Load configuration from file or use defaults
 */
export function loadConfig(): ServerConfig {
  // Try to load from config file
  for (const configPath of CONFIG_PATHS) {
    if (existsSync(configPath)) {
      try {
        const fileContent = readFileSync(configPath, 'utf-8');
        const userConfig = JSON.parse(fileContent);

        // Deep merge with defaults
        const config = mergeConfig(DEFAULT_CONFIG, userConfig);

        return config;
      } catch (error) {
        console.error(`Failed to load config from ${configPath}:`, error);
        // Continue to next config path
      }
    }
  }

  // No config file found, use defaults
  return DEFAULT_CONFIG;
}

/**
 * Deep merge two configuration objects
 */
function mergeConfig(defaults: ServerConfig, overrides: Partial<ServerConfig>): ServerConfig {
  return {
    browser: {
      ...defaults.browser,
      ...(overrides.browser || {}),
    },
    console: {
      ...defaults.console,
      ...(overrides.console || {}),
      truncation: {
        ...defaults.console.truncation,
        ...(overrides.console?.truncation || {}),
      },
    },
    screenshots: {
      ...defaults.screenshots,
      ...(overrides.screenshots || {}),
    },
  };
}

/**
 * Validate configuration
 */
export function validateConfig(config: ServerConfig): void {
  // Validate browser config
  if (!Array.isArray(config.browser.args)) {
    throw new Error('browser.args must be an array');
  }

  // Validate console config
  if (config.console.bufferSize <= 0) {
    throw new Error('console.bufferSize must be positive');
  }

  if (!Array.isArray(config.console.filterLevels)) {
    throw new Error('console.filterLevels must be an array');
  }

  // Validate truncation config
  const { truncation } = config.console;
  if (truncation.maxStringLength <= 0) {
    throw new Error('console.truncation.maxStringLength must be positive');
  }
  if (truncation.maxArrayLength <= 0) {
    throw new Error('console.truncation.maxArrayLength must be positive');
  }
  if (truncation.maxObjectDepth <= 0) {
    throw new Error('console.truncation.maxObjectDepth must be positive');
  }

  // Validate screenshot config
  if (!['png', 'jpeg'].includes(config.screenshots.defaultFormat)) {
    throw new Error('screenshots.defaultFormat must be "png" or "jpeg"');
  }
  if (config.screenshots.quality < 0 || config.screenshots.quality > 100) {
    throw new Error('screenshots.quality must be between 0 and 100');
  }
}

/**
 * Get configuration with validation
 */
export function getConfig(): ServerConfig {
  const config = loadConfig();
  validateConfig(config);
  return config;
}
