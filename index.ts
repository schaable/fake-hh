#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fork } from 'node:child_process';
import * as glob from 'glob';

const JS_CONFIG_FILENAME = 'hardhat.config.js';
const CJS_CONFIG_FILENAME = 'hardhat.config.cjs';
const TS_CONFIG_FILENAME = 'hardhat.config.ts';
const CTS_CONFIG_FILENAME = 'hardhat.config.cts';
const TEST_DIR = 'test';

const GH_API_URL = 'https://api.github.com';
const GH_OWNER = 'schaable'; // 'NomicFoundation';
const GH_REPO = 'fake-hh'; // 'hardhat-v3-research-esm-ts';

interface Release {
  url: string;
  assets_url: string;
  upload_url: string;
  html_url: string;
  id: number;
  author: {};
  node_id: string;
  tag_name: string;
  target_commitish: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  assets: any[];
  tarball_url: string;
  zipball_url: string;
  body: string;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    throw new Error('No command provided');
  }

  if (await isTsConfig()) {
    const tsNode = await import('ts-node');
    const opts = args[0] === 'test' ? { transpileOnly: true } : {};
    tsNode.register(opts);
  }

  const config = await loadConfig();
  console.log('Config loaded', config);

  if (args[0] === 'run') {
    await run(args[1]);
    return;
  }

  if (args[0] === 'test') {
    const testFailures = await test();
    if (testFailures > 0) {
      await versionNotifier();
    }
    return;
  }

  throw new Error(`Unknown command ${args[0]}`);
}

async function loadConfig(): Promise<Record<string, any>> {
  const configPath = await getConfigPath();

  let userConfig: any;
  try {
    const imported = require(configPath);
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
    ? glob.sync(`${TEST_DIR}/**/*.{js,cjs,mjs,ts,cts}`)
    : glob.sync(`${TEST_DIR}/**/*.{js,cjs,mjs}`);

  const mocha = new Mocha();
  files.forEach((file) => mocha.addFile(file));

  // if the project is of type "module" or if there's some ESM test file,
  // we call loadFilesAsync to enable Mocha's ESM support
  const isTypeModule = await isESM();
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

async function isESM(): Promise<boolean> {
  try {
    const packageJsonAsText = await readFile(resolve(process.cwd(), 'package.json'), 'utf-8');
    const packageJson = JSON.parse(packageJsonAsText);
    return packageJson.type === 'module';
  } catch {
    throw new Error('Failed to read package.json');
  }
}

async function isTsConfig(): Promise<boolean> {
  try {
    await Promise.any([
      access(resolve(process.cwd(), CTS_CONFIG_FILENAME)),
      access(resolve(process.cwd(), TS_CONFIG_FILENAME)),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function getConfigPath(): Promise<string> {
  const configFiles = [JS_CONFIG_FILENAME, CJS_CONFIG_FILENAME, TS_CONFIG_FILENAME, CTS_CONFIG_FILENAME];

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

async function versionNotifier() {
  const semver = await import('semver');
  const { default: envPaths } = await import('env-paths');
  const { cache } = envPaths('fake-hh');
  const versionNotifierCachePath = join(cache, 'version-notifier.json');

  let lastCheck: string | 0;
  let v3TimesShown: number;
  try {
    await access(versionNotifierCachePath);
    const fileContent = await readFile(versionNotifierCachePath, 'utf-8');
    const parsedData = JSON.parse(fileContent);
    lastCheck = parsedData.lastCheck ?? 0;
    v3TimesShown = parsedData.v3TimesShown ?? 0;
  } catch (error: any) {
    lastCheck = 0;
    v3TimesShown = 0;
  }

  const lastCheckDate = new Date(lastCheck);
  const now = new Date();
  const oneDay = 1000 * 60 * 60 * 24;

  if (now.getTime() - lastCheckDate.getTime() > oneDay) {
    const { dependencies, devDependencies } = JSON.parse(
      await readFile(resolve(__dirname, '../../package.json'), 'utf-8')
    );
    const localVersion = dependencies['fake-hh'] ?? devDependencies['fake-hh'];

    const githubResponse = await fetch(`${GH_API_URL}/repos/${GH_OWNER}/${GH_REPO}/releases?per_page=100`);
    const releases: Release[] = await githubResponse.json();
    let latestv2Release: Release | undefined;
    let v3Release: Release | undefined;
    releases.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    for (const release of releases) {
      if (release.draft || release.prerelease) {
        continue;
      }

      // tagname has the format package@semverVersion so we need to split it
      const [packageName, packageVersion] = release.tag_name.split('@');
      if (packageName === GH_REPO && semver.valid(packageVersion) !== null) {
        if (!latestv2Release && semver.major(packageVersion) === 0 /* 2 */) {
          latestv2Release = release;
        } else if (!v3Release && semver.eq(packageVersion, '1.0.0' /* '3.0.0' */)) {
          v3Release = release;
        }

        if (latestv2Release && v3Release) {
          break;
        }
      }
    }

    if (!latestv2Release && !v3Release) {
      return;
    }

    if (latestv2Release && semver.gt(latestv2Release.tag_name.split('@')[1], localVersion)) {
      console.log(
        `There's a new version of ${GH_REPO} available: ${latestv2Release.tag_name}! Run "npm i ${GH_REPO}" to update.\n`
      );
    }

    if (v3Release && semver.gt(v3Release.tag_name.split('@')[1], localVersion)) {
      if (v3TimesShown < 5) {
        let v3Message = `The next major version of ${GH_REPO} is available: ${v3Release.tag_name}! Check out the release notes at ${v3Release.html_url}.\n`;
        for (const asset of v3Release.assets) {
          if (asset.name === 'version-notifier-message.txt') {
            const githubResponse = await fetch(asset.browser_download_url);
            v3Message = await githubResponse.text();
          }
        }
        console.log(v3Message);
        v3TimesShown++;
      }
    }

    if (latestv2Release || v3Release) {
      await mkdir(cache, { recursive: true });
      await writeFile(versionNotifierCachePath, JSON.stringify({ lastCheck: now, v3TimesShown }));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
