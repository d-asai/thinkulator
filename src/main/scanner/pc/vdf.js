'use strict';

/**
 * Parser for Valve's text KeyValues format (libraryfolders.vdf, appmanifest_*.acf).
 *
 *   "libraryfolders"
 *   {
 *       "0" { "path" "C:\\Program Files (x86)\\Steam"  "apps" { "620" "123" } }
 *   }
 *
 * Returns nested plain objects with string leaves. A repeated key keeps the
 * last value, which is what Steam itself does for these files.
 */
function parseVdf(text) {
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  function skip() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
      } else break;
    }
  }

  function token() {
    skip();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return { brace: c }; }
    if (c === '"') {
      i++;
      let out = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else out += text[i++];
      }
      i++; // closing quote
      return { value: out };
    }
    let out = '';
    while (i < n && !/[\s{}"]/.test(text[i])) out += text[i++];
    return { value: out };
  }

  function object(top) {
    const obj = {};
    for (;;) {
      const key = token();
      if (key === null) {
        if (top) return obj;
        throw new Error('VDF: unexpected end of input');
      }
      if (key.brace === '}') {
        if (top) throw new Error('VDF: unbalanced }');
        return obj;
      }
      if (key.brace) throw new Error('VDF: unexpected {');
      const val = token();
      if (val === null) throw new Error('VDF: key without value');
      if (val.brace === '{') obj[key.value] = object(false);
      else if (val.brace) throw new Error('VDF: unexpected }');
      else obj[key.value] = val.value;
    }
  }

  return object(true);
}

/** Case-insensitive property lookup: Steam is inconsistent about key casing. */
function vdfGet(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (key in obj) return obj[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}

module.exports = { parseVdf, vdfGet };
