export type TokenKind = 'open' | 'close' | 'selfclose' | 'text' | 'comment' | 'doctype';

export interface Token {
  kind: TokenKind;
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
  pos: number;
}

// Parse all attributes out of a raw attribute string like: foo="bar" baz qux='hello'
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  // Match name="value", name='value', name=value, or standalone name
  const re = /([a-zA-Z_:][a-zA-Z0-9_.:\-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1]!.toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[name] = val;
  }
  return attrs;
}

export function* tokenize(html: string): Generator<Token> {
  let i = 0;
  const len = html.length;

  while (i < len) {
    if (html[i] !== '<') {
      // Text node
      const start = i;
      while (i < len && html[i] !== '<') i++;
      yield { kind: 'text', text: html.slice(start, i), pos: start };
      continue;
    }

    const pos = i;
    i++; // consume '<'

    if (i >= len) {
      yield { kind: 'text', text: '<', pos };
      continue;
    }

    // Comment <!-- ... -->
    if (html.startsWith('!--', i)) {
      i += 3;
      const end = html.indexOf('-->', i);
      if (end === -1) {
        yield { kind: 'comment', text: html.slice(i), pos };
        i = len;
      } else {
        yield { kind: 'comment', text: html.slice(i, end), pos };
        i = end + 3;
      }
      continue;
    }

    // DOCTYPE
    if (html[i] === '!' || html.slice(i, i + 7).toLowerCase() === '!doctyp') {
      const end = html.indexOf('>', i);
      if (end === -1) { i = len; } else { i = end + 1; }
      yield { kind: 'doctype', pos };
      continue;
    }

    // Close tag </tagname>
    if (html[i] === '/') {
      i++;
      const start = i;
      while (i < len && html[i] !== '>' && html[i] !== ' ' && html[i] !== '\n' && html[i] !== '\t') i++;
      const tag = html.slice(start, i).toLowerCase().trim();
      while (i < len && html[i] !== '>') i++;
      if (i < len) i++; // consume '>'
      yield { kind: 'close', tag, pos };
      continue;
    }

    // Open or self-close tag
    const start = i;
    // Tag name: stop at whitespace, /, or >
    while (i < len && html[i] !== '>' && html[i] !== '/' && html[i] !== ' ' && html[i] !== '\n' && html[i] !== '\t' && html[i] !== '\r') i++;
    const tag = html.slice(start, i).toLowerCase().trim();

    if (!tag) {
      // malformed, skip to next >
      while (i < len && html[i] !== '>') i++;
      if (i < len) i++;
      continue;
    }

    // Collect raw attribute string (skip past whitespace before >)
    let rawAttrs = '';
    let selfClose = false;

    if (i < len && (html[i] === ' ' || html[i] === '\n' || html[i] === '\t' || html[i] === '\r')) {
      // Read until '>' or '/>'
      const attrStart = i;
      while (i < len && html[i] !== '>') {
        if (html[i] === '/' && html[i + 1] === '>') { selfClose = true; i++; break; }
        i++;
      }
      rawAttrs = html.slice(attrStart, i);
    } else if (html[i] === '/') {
      selfClose = true;
      i++;
    }

    if (i < len && html[i] === '>') i++;

    const attrs = parseAttrs(rawAttrs);
    const kind: TokenKind = selfClose ? 'selfclose' : 'open';
    yield { kind, tag, attrs, pos };
  }
}
