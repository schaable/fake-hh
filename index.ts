#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const JS_CONFIG_FILENAME = 'hardhat.config.js';
const CJS_CONFIG_FILENAME = 'hardhat.config.cjs';
const TS_CONFIG_FILENAME = 'hardhat.config.ts';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    throw new Error('No command provided');
  }

  if (await isTsConfig()) {
    const tsNode = await import('ts-node');
    tsNode.register();
  }

  const config = await loadConfig();
  console.log('Config loaded', config);

  if (args[0] === 'run') {
    await run(args[1]);
    return;
  }

  if (args[0] === 'test') {
    await test();
    return;
  }

  throw new Error(`Unknown command ${args[0]}`);
}

async function loadConfig(): Promise<Record<string, any>> {
  const configPath = (await isTsConfig()) ? 'hardhat.config.ts' : 'hardhat.config.js';

  let userConfig: any;
  try {
    const imported = require(await getConfigPath());
    userConfig = imported.default !== undefined ? imported.default : imported;
  } catch (e) {
    throw new Error(`Failed to load config file ${configPath}`);
  }

  const defaultConfig = {};

  return { ...defaultConfig, ...userConfig };
}

async function run(scriptPath: string | undefined) {
  if (!scriptPath) {
    throw new Error('No script path provided');
  }

  console.log('Running');
}

async function test() {
  console.log('Testing');
}

async function isTsConfig(): Promise<boolean> {
  try {
    await access(resolve(process.cwd(), TS_CONFIG_FILENAME));
    return true;
  } catch {
    return false;
  }
}

async function getConfigPath(): Promise<string> {
  const configFiles = [TS_CONFIG_FILENAME, CJS_CONFIG_FILENAME, JS_CONFIG_FILENAME];

  for (const configFile of configFiles) {
    const configPath = resolve(process.cwd(), configFile);
    try {
      await access(configPath);
      return configPath;
    } catch (error) {
      // ignore
    }
  }

  throw new Error('No config file found');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
