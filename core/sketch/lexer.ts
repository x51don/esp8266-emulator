/**
 * Lexer + minimal preprocessor for the Arduino-C++ subset accepted by the
 * emulator. Supports: identifiers, numeric literals (dec/hex/bin, L/U/UL/F
 * suffixes, floats), char and string literals, all common C operators,
 * C/C++ comments, `#include` (dropped) and object-like `#define` expansion.
 * Function-like macros are rejected with a clear error (sketches should use
 * inline functions instead).
 */

export type TokenType = 'ident' | 'num' | 'str' | 'char' | 'punct' | 'eof';

export interface Token {
  type: TokenType;
  value: string;   // raw text for ident/punct, decoded text for str/char
  num?: number;    // numeric value for num tokens
  isFloat?: boolean;
  line: number;    // 1-based
  pos: number;     // offset in preprocessed code
}

export class SketchError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`${message} (line ${line})`);
    this.name = 'SketchError';
  }
}

const PUNCTUATORS = [
  '<<=', '>>=', '&&=', '||=', '**=',
  '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '->', '::',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '~', '^', '|', '&',
  '?', ':', ';', ',', '.', '(', ')', '[', ']', '{', '}',
];

const ID_START = /[A-Za-z_]/;
const ID_PART = /[A-Za-z0-9_]/;

/**
 * Expand object-like #defines and drop #include/#pragma lines.
 * Returns the rewritten code plus the define table (useful for hover/debug).
 */
export function preprocess(
  src: string,
): { code: string; defines: Record<string, string> } {
  const defines: Record<string, string> = {};
  const lines = src.split('\n');
  const kept: string[] = [];

  // Conditional-compilation frames. active = this branch emits its lines;
  // taken = some branch of this #if chain has fired (so #else/#elif sleep).
  const stack: Array<{ active: boolean; taken: boolean }> = [];
  const live = () => stack.every((f) => f.active);
  const parentLive = (depth: number) => stack.slice(0, depth - 1).every((f) => f.active);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i];
    const dir = /^\s*#\s*(\w+)\s*(.*)$/.exec(raw);
    if (!dir) {
      kept.push(live() ? raw : '');
      continue;
    }
    const [, kind, restRaw] = dir;
    const rest = restRaw.trim();

    if (kind === 'include' || kind === 'pragma' || kind === 'using') {
      kept.push(''); // keep line numbering intact
    } else if (kind === 'ifdef' || kind === 'ifndef') {
      const name = rest.split(/\s+/)[0];
      const cond = kind === 'ifdef' ? name in defines : !(name in defines);
      const active = live() && cond;
      stack.push({ active, taken: active });
      kept.push('');
    } else if (kind === 'if') {
      // only #if 0 / #if 1 - real sketches in this codebase stop there
      if (!/^[01]$/.test(rest)) {
        throw new SketchError('unsupported #if expression (only #if 0 and #if 1)', lineNo);
      }
      const active = live() && rest === '1';
      stack.push({ active, taken: active });
      kept.push('');
    } else if (kind === 'elif') {
      if (!stack.length) throw new SketchError("#elif without #if", lineNo);
      const m = /^defined\s*\(?\s*(\w+)\s*\)?$|^(\w+)$/.exec(rest);
      if (!m) throw new SketchError('unsupported #elif expression (only defined(X))', lineNo);
      const f = stack[stack.length - 1];
      const cond = (m[1] ?? m[2]) in defines;
      f.active = parentLive(stack.length) && !f.taken && cond;
      if (f.active) f.taken = true;
      kept.push('');
    } else if (kind === 'else') {
      if (!stack.length) throw new SketchError('#else without #if', lineNo);
      const f = stack[stack.length - 1];
      f.active = parentLive(stack.length) && !f.taken;
      if (f.active) f.taken = true;
      kept.push('');
    } else if (kind === 'endif') {
      if (!stack.length) throw new SketchError('#endif without #if', lineNo);
      stack.pop();
      kept.push('');
    } else if (kind === 'define') {
      if (live()) {
        const m = /^(\w+)\s*\((.*)$/.exec(rest);
        if (m) {
          throw new SketchError(
            'function-like macros are not supported; use an inline function',
            lineNo,
          );
        }
        // an empty define (FIXEDIP, ICACHE_RAM_ATTR) must expand to nothing;
        // a trailing // comment is not part of the value ("// c" after "48")
        const body = stripLineComment(rest);
        const d = /^(\w+)\s+([\s\S]*)$/.exec(body);
        if (d) defines[d[1]] = d[2].trim();
        else if (/^\w+$/.test(body)) defines[body] = '';
      }
      kept.push('');
    } else if (kind === 'undef') {
      if (live()) delete defines[rest.split(/\s+/)[0]];
      kept.push('');
    } else {
      throw new SketchError(`unsupported preprocessor directive '#${kind}'`, lineNo);
    }
  }
  if (stack.length) {
    throw new SketchError('unterminated #ifdef (missing #endif)', 0);
  }

  let code = kept.join('\n');

  // Iterative expansion (defines may reference earlier defines). Bounded to
  // break accidental cycles; real sketches need at most a couple of rounds.
  const names = Object.keys(defines).sort((a, b) => b.length - a.length);
  for (let round = 0; round < 10 && names.length > 0; round++) {
    let changed = false;
    for (const name of names) {
      const re = new RegExp(`(?<![\\w.])${name}(?![\\w])`, 'g');
      if (re.test(code)) {
        code = code.replace(re, () => defines[name]); // a $ in the value stays literal
        changed = true;
      }
    }
    if (!changed) break;
  }

  return { code, defines };
}

/** Remove a trailing // comment, respecting "strings" and 'chars'. */
function stripLineComment(s: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '/' && s[i + 1] === '/') return s.slice(0, i).trimEnd();
  }
  return s;
}

export function tokenize(src: string, alreadyPreprocessed = false): Token[] {
  const { code } = alreadyPreprocessed ? { code: src } : preprocess(src);
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  const fail = (msg: string): never => {
    throw new SketchError(msg, line);
  };

  while (i < code.length) {
    const ch = code[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }

    // Comments
    if (ch === '/' && code[i + 1] === '/') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated block comment');
      for (let k = i; k < end; k++) if (code[k] === '\n') line++;
      i = end + 2;
      continue;
    }

    // Identifiers / keywords
    if (ID_START.test(ch)) {
      let j = i + 1;
      while (j < code.length && ID_PART.test(code[j])) j++;
      tokens.push({ type: 'ident', value: code.slice(i, j), line, pos: i });
      i = j;
      continue;
    }

    // Numbers: decimal, hex (0x), binary (0b), floats, integer suffixes
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(code[i + 1] ?? ''))) {
      const startLine = line;
      const m = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?)([uUlLfF]*)/.exec(code.slice(i)) ?? fail(`invalid number near "${code.slice(i, i + 8)}"`);
      const text = m[0];
      const body = m[1];
      let value: number;
      if (/^0[xX]/.test(body)) value = parseInt(body, 16);
      else if (/^0[bB]/.test(body)) value = parseInt(body.slice(2), 2);
      else value = Number(body);
      tokens.push({
        type: 'num',
        value: text,
        num: value,
        isFloat: /[.eE]/.test(body) || /[fF]/.test(m[4] ?? ''),
        line: startLine,
        pos: i,
      });
      i += text.length;
      continue;
    }

    // Char literal
    if (ch === "'") {
      const res = readQuoted(code, i, "'", line);
      if (res === null) fail('unterminated char literal');
      tokens.push({ type: 'char', value: res!.text, line, pos: i });
      line += res!.newlines;
      i = res!.end;
      continue;
    }

    // String literal
    if (ch === '"') {
      const res = readQuoted(code, i, '"', line);
      if (res === null) fail('unterminated string literal');
      tokens.push({ type: 'str', value: res!.text, line, pos: i });
      line += res!.newlines;
      i = res!.end;
      continue;
    }

    // Punctuation (longest match first)
    const punct = PUNCTUATORS.find((p) => code.startsWith(p, i)) ?? fail(`unexpected character '${ch}'`);
    tokens.push({ type: 'punct', value: punct!, line, pos: i });
    i += punct!.length;
  }

  tokens.push({ type: 'eof', value: '', line, pos: code.length });
  return tokens;
}

/** Read a quoted literal ('x' or "..."), honouring backslash escapes. */
function readQuoted(
  code: string,
  start: number,
  quote: string,
  _line: number,
): { text: string; end: number; newlines: number } | null {
  let out = '';
  let i = start + 1;
  let newlines = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '\n') return null; // strings/chars do not span lines here
    if (ch === '\\') {
      const next = code[i + 1];
      const map: Record<string, string> = {
        n: '\n', t: '\t', r: '\r', '0': '\0', "'": "'", '"': '"', '\\': '\\',
      };
      if (next === undefined) return null;
      out += map[next] ?? next;
      i += 2;
      continue;
    }
    if (ch === quote) return { text: out, end: i + 1, newlines };
    out += ch;
    i++;
  }
  return null;
}
