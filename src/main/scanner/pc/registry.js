'use strict';

const { execFile } = require('node:child_process');

const KEY_RE = /^HK(LM|CU|EY_LOCAL_MACHINE|EY_CURRENT_USER)\\[\w\\ .()\-]+$/;

/**
 * Reads a registry key (recursively) with reg.exe, so no native module is
 * needed. Output is forced to UTF-8 so non-ASCII game names survive.
 *
 * @returns {Promise<Map<string, Record<string,string>>>} full key path -> values.
 *          Empty when the key does not exist or on a non-Windows platform.
 */
function queryRegistry(key, { recursive = true } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(new Map());
  // Keys are constants from this code base; the check keeps it that way.
  if (!KEY_RE.test(key)) return Promise.reject(new Error(`Refusing to query registry key: ${key}`));

  const command = `chcp 65001>nul & reg query "${key}"${recursive ? ' /s' : ''}`;
  return new Promise((resolve) => {
    execFile('cmd.exe', ['/d', '/c', command], {
      windowsHide: true, windowsVerbatimArguments: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
    }, (err, stdout) => {
      if (err && !stdout) return resolve(new Map());
      resolve(parseRegOutput(stdout));
    });
  });
}

function parseRegOutput(text) {
  const keys = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^HKEY_/.test(line)) {
      current = {};
      keys.set(line.trim(), current);
      continue;
    }
    if (!current || !line.startsWith('    ')) continue;
    // "    <name>    <REG_TYPE>    <data>"; data may be empty or contain runs of spaces.
    const m = line.match(/^ {4}(.*?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/);
    if (m) current[m[1]] = m[3] === undefined ? '' : m[3];
  }
  return keys;
}

/** First value named `name` (case-insensitive) in a values object. */
function regValue(values, name) {
  if (!values) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(values)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

module.exports = { queryRegistry, parseRegOutput, regValue };
