#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fork } from 'node:child_process';
import * as glob from 'glob';

const JS_CONFIG_FILENAME = 'hardhat.config.js';
const CJS_CONFIG_FILENAME = 'hardhat.config.cjs';
const TS_CONFIG_FILENAME = 'hardhat.config.ts';
const TEST_DIR = 'test';

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

  try {
    await access(resolve(process.cwd(), scriptPath));
    await runScript(scriptPath);
  } catch {
    throw new Error(`Script ${scriptPath} not found`);
  }
}

async function test() {
  const { default: Mocha } = await import('mocha');

  const files = (await isTsConfig())
    ? glob.sync(`${TEST_DIR}/**/*.{js,cjs,mjs,ts}`)
    : glob.sync(`${TEST_DIR}/**/*.{js,cjs,mjs}`);

  const mocha = new Mocha();
  files.forEach((file) => mocha.addFile(file));

  // if the project is of type "module" or if there's some ESM test file,
  // we call loadFilesAsync to enable Mocha's ESM support
  const packageJsonAsText = await readFile(resolve(process.cwd(), 'package.json'), 'utf-8');
  const projectPackageJson = JSON.parse(packageJsonAsText);
  const isTypeModule = projectPackageJson.type === 'module';
  const hasEsmTest = files.some((file) => file.endsWith('.mjs'));
  if (isTypeModule || hasEsmTest) {
    // This instructs Mocha to use the more verbose file loading infrastructure
    // which supports both ESM and CJS
    await mocha.loadFilesAsync();
  }

  const testFailures = await new Promise<number>((resolve) => mocha.run(resolve));
  process.exitCode = testFailures;
  return testFailures;
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

async function runScript(scriptPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const getTsNodeArgsIfNeeded = (scriptPath: string) =>
      /\.tsx?$/i.test(scriptPath) ? ['--require', 'ts-node/register'] : [];

    const childProcess = fork(scriptPath, undefined, {
      stdio: 'inherit',
      execArgv: [...process.execArgv, ...getTsNodeArgsIfNeeded(scriptPath)],
      env: process.env,
    });

    childProcess.once('close', (status) => resolve(status as number));
    childProcess.once('error', reject);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
