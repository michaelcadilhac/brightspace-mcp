import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { chromium } from 'playwright';
import { D2LError } from './errors.js';

export interface BrowserExecutable { path: string; source: 'configured' | 'playwright' | 'system' }

async function executable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

/** Resolve a browser binary only; every launch still uses our dedicated persistent profile. */
export async function resolveChromiumExecutable(options: {
  configured?: string; bundled?: string; systemPaths?: string[];
} = {}): Promise<BrowserExecutable> {
  if (options.configured !== undefined) {
    if (await executable(options.configured)) return { path: options.configured, source: 'configured' };
    throw new D2LError('SERVER_FEATURE_MISSING', 'The configured Chromium executable is missing or is not executable.',
      { startupReason: 'INVALID_BROWSER_EXECUTABLE', executablePath: options.configured },
      'Correct auth.executablePath in the config, or remove it to enable browser discovery.');
  }
  const bundled = options.bundled ?? chromium.executablePath();
  if (await executable(bundled)) return { path: bundled, source: 'playwright' };
  const systemPaths = options.systemPaths ?? ['/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const path of systemPaths) if (await executable(path)) return { path, source: 'system' };
  throw new D2LError('SERVER_FEATURE_MISSING', 'No usable Chromium executable was found.',
    { startupReason: 'BROWSER_NOT_INSTALLED', checkedPaths: [bundled, ...systemPaths] },
    'Install Chromium with your system package manager, run npx playwright install chromium, or set auth.executablePath to an installed browser.');
}

/** Classify fixed startup evidence rather than returning raw browser logs, which may contain secrets. */
export function browserLaunchError(error: unknown, browser: BrowserExecutable, headless: boolean): D2LError {
  const message = error instanceof Error ? error.message : '';
  const evidence = { executablePath: browser.path, browserSource: browser.source, headless };
  if (/ProcessSingleton|SingletonLock|profile.*(?:in use|already.*used)/i.test(message)) {
    return new D2LError('PROFILE_IN_USE', 'Chromium reports that the dedicated browser profile already has an owner.',
      { ...evidence, startupReason: 'BROWSER_PROFILE_IN_USE' },
      'Close the process using the dedicated profile before retrying. Do not delete a live browser lock.');
  }
  if (/Missing X server|\$DISPLAY|cannot open display|failed to (?:initialize|connect to) (?:X11|Wayland)|ozone_platform_x11/i.test(message)) {
    return new D2LError('SERVER_FEATURE_MISSING', 'Chromium cannot access a graphical display for manual login.',
      { ...evidence, startupReason: 'DISPLAY_UNAVAILABLE' },
      'Run login in a terminal in your graphical desktop session with working display access.');
  }
  const library = message.match(/error while loading shared libraries:\s*([a-z0-9_.+-]+)/i)?.[1];
  if (library) return new D2LError('SERVER_FEATURE_MISSING', 'Chromium is missing a shared-library dependency.',
    { ...evidence, startupReason: 'MISSING_BROWSER_LIBRARY', library },
    'Install the browser runtime dependencies with your system package manager.');
  if (/No usable sandbox|Running as root without --no-sandbox|Failed to move to new namespace|Operation not permitted|spawn.*EACCES/i.test(message)) {
    return new D2LError('LOCAL_PERMISSION_DENIED', 'The process environment prevented Chromium from starting.',
      { ...evidence, startupReason: 'BROWSER_PROCESS_RESTRICTED' },
      'Run login as your desktop user in a normal terminal, and check the local process and sandbox permissions.');
  }
  return new D2LError('INTERNAL_ERROR', 'The Chromium executable was found, but browser startup failed.',
    { ...evidence, startupReason: 'BROWSER_STARTUP_FAILED' },
    'Check this executable, graphical display access for login, and ownership of the dedicated browser profile.');
}
