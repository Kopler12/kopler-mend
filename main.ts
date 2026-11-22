// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Shared context for the parsers of sections 6 to 8: strict matching and the moves made. */
interface Ctx {
  strict: boolean;
  moves: { old: string; new: string }[];
}

function parseErr(n: number): never {
  throw new Exit2(`error: parse ${n}`);
}

/** A file's lines, its line break, and whether it ends with one (section 3). */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** The first tier at which O occurs in `lines`, with every occurrence position, or null. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at: number[] = [];
    for (let i = 0; i + o.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (!lineEq(lines[i + j]!, o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/**
 * Replace O's lines at `pos` with N. `ctx[j]` is the index into O of the context line N[j]
 * repeats, or null for a new line. A context line is written as the file's own matched line;
 * at tier 2 every other line is re-indented from O's first line's leading whitespace to the
 * file's first matched line's (section 5).
 */
function replaceAt(lines: string[], pos: number, o: string[], n: string[], ctx: (number | null)[], tier: number): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? leadWs(lines[pos]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  for (let j = 0; j < n.length; j += 1) {
    const c = ctx[j]!;
    if (c !== null) {
      out.push(lines[pos + c]!);
    } else {
      const s = n[j]!;
      if (tier === 2 && s !== '' && s.trim() !== '' && s.startsWith(p)) out.push(f + s.slice(p.length));
      else out.push(s);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk of a unified diff (section 6). `ctx[j]` is the index into `o` of the context line `n[j]` repeats, or null. */
interface Hunk {
  a: number;
  o: string[];
  n: string[];
  ctx: (number | null)[];
  /** A `\` line follows the hunk's last context or `+` line. */
  endsNoEol: boolean;
  /** The hunk's `+` lines in order, and whether a `\` line follows its last one. */
  plus: string[];
  plusNoEol: boolean;
}

/** Apply a section's hunks in order to a file's text; `failPath` names the file on no-match. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  let { lines, br, final } = splitFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const touches = at === lines.length;
      lines = [...lines.slice(0, at), ...h.n, ...lines.slice(at)];
      if (touches) final = !h.endsNoEol;
      d += h.n.length;
      continue;
    }
    const found = findTier(lines, h.o, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.at[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.at) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const touches = best + h.o.length === lines.length;
    lines = replaceAt(lines, best, h.o, h.n, h.ctx, found.tier);
    if (touches) final = !h.endsNoEol;
    d += h.n.length - h.o.length;
  }
  return joinFile(lines, br, final);
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** A leading `a/` or `b/` is removed from a `--- ` / `+++ ` path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Unified diffs (section 6). */
function unifiedEdits(lines: string[], ctx: Ctx): Edit[] {
  interface Sec {
    pairOld: string | null;
    pairNew: string | null;
    sawPair: boolean;
    diffOld: string;
    diffNew: string;
    renameFrom: string | null;
    renameTo: string | null;
    isNew: boolean;
    isDeleted: boolean;
    hunks: Hunk[];
  }
  const newSec = (): Sec => ({
    pairOld: null,
    pairNew: null,
    sawPair: false,
    diffOld: '',
    diffNew: '',
    renameFrom: null,
    renameTo: null,
    isNew: false,
    isDeleted: false,
    hunks: [],
  });
  const secs: Sec[] = [];
  let cur: Sec | null = null;
  let inHeader = false;
  let i = 0;

  const readHunk = (): Hunk => {
    const m = lines[i]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    const a = parseInt(m![1]!, 10);
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j]!;
      if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
      if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
        body.push(l);
        j += 1;
      } else break;
    }
    while (body.length > 0 && body[body.length - 1] === '') body.pop();
    i = j;
    const o: string[] = [];
    const n: string[] = [];
    const c: (number | null)[] = [];
    const plus: string[] = [];
    for (const l of body) {
      if (l === '' || l[0] === ' ') {
        c.push(o.length);
        o.push(l === '' ? '' : l.slice(1));
        n.push(l === '' ? '' : l.slice(1));
      } else if (l[0] === '-') o.push(l.slice(1));
      else if (l[0] === '+') {
        c.push(null);
        n.push(l.slice(1));
        plus.push(l.slice(1));
      }
    }
    let lastN = -1;
    let lastPlus = -1;
    for (let k = 0; k < body.length; k += 1) {
      const l = body[k]!;
      if (l === '' || l[0] === ' ' || l[0] === '+') lastN = k;
      if (l[0] === '+') lastPlus = k;
    }
    const after = (k: number): boolean => k >= 0 && body[k + 1] !== undefined && body[k + 1]![0] === '\\';
    return { a, o, n, ctx: c, endsNoEol: after(lastN), plus, plusNoEol: after(lastPlus) };
  };

  const addHunk = (): void => {
    if (lines[i]!.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/) === null) parseErr(i + 1);
    cur!.hunks.push(readHunk());
    inHeader = false;
  };

  const setPair = (minus: string, plusLine: string): void => {
    const oldRaw = headerPath(minus);
    const newRaw = headerPath(plusLine);
    cur!.pairOld = oldRaw === '/dev/null' ? null : stripAB(oldRaw);
    cur!.pairNew = newRaw === '/dev/null' ? null : stripAB(newRaw);
    cur!.sawPair = true;
  };

  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = l.match(/^diff --git a\/(\S+) b\/(\S+)$/);
      if (m === null) parseErr(i + 1);
      cur = newSec();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      secs.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !cur.sawPair) {
        setPair(l, lines[i + 1]!);
        i += 2;
        continue;
      }
      cur = newSec();
      secs.push(cur);
      inHeader = true;
      setPair(l, lines[i + 1]!);
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) parseErr(i + 2);
      if (l.startsWith('+++ ')) {
        const raw = headerPath(l);
        cur.pairNew = raw === '/dev/null' ? null : stripAB(raw);
        cur.sawPair = true;
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        addHunk();
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isNew = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDeleted = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) parseErr(i + 1);
      addHunk();
      continue;
    }
    i += 1;
  }

  const edits: Edit[] = [];
  for (const s of secs) {
    const oldP = s.sawPair ? s.pairOld : (s.renameFrom ?? (s.diffOld === '' ? null : s.diffOld));
    const newP = s.sawPair ? s.pairNew : (s.renameTo ?? (s.diffNew === '' ? null : s.diffNew));
    const creation = oldP === null || s.isNew;
    const deletion = !creation && (newP === null || s.isDeleted);
    if (creation) {
      const p = newP ?? '';
      const plus: string[] = [];
      for (const h of s.hunks) plus.push(...h.plus);
      let noEol = false;
      for (const h of s.hunks) if (h.plus.length > 0) noEol = h.plusNoEol;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(plus, '\n', !noEol));
      });
      continue;
    }
    if (deletion) {
      const p = oldP ?? '';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    const oldPath = oldP ?? '';
    const newPath = newP ?? '';
    if (oldPath !== newPath) {
      edits.push((tree) => {
        if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
        if (!safe(newPath)) throw new Fail('unsafe', newPath);
        const before = tree.get(oldPath);
        if (before === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const out = applyHunks(before, s.hunks, ctx.strict, oldPath);
        tree.now.set(oldPath, null);
        tree.now.set(newPath, out);
        ctx.moves.push({ old: oldPath, new: newPath });
      });
      continue;
    }
    edits.push((tree) => {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, applyHunks(before, s.hunks, ctx.strict, oldPath));
    });
  }
  return edits;
}

/** SEARCH/REPLACE blocks (section 7). */
function srEdits(lines: string[], ctx: Ctx): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) parseErr(s + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) parseErr(s + 1);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) parseErr(s + 1);
    const old = lines.slice(s + 1, eq);
    const nw = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(nw, '\n', true));
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const { lines: fl, br, final } = splitFile(before);
      const found = findTier(fl, old, ctx.strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const out = replaceAt(fl, found.at[0]!, old, nw, nw.map(() => null), found.tier);
      tree.now.set(p, joinFile(out, br, final));
    });
    prevPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** V4A patches (section 8). */
function v4aEdits(lines: string[], ctx: Ctx): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) parseErr(1);
  if (lines[first]!.trim() !== '*** Begin Patch') parseErr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') parseErr(lines.length + 1);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const head = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (head.startsWith('*** Add File: ')) {
      kind = 'add';
      path = head.slice(14).trim();
    } else if (head.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = head.slice(17).trim();
    } else if (head.startsWith('*** Update File: ')) {
      kind = 'update';
      path = head.slice(17).trim();
    } else parseErr(i + 1);
    const headerLine = i + 1;
    i += 1;
    let j = i;
    while (j < last && !isSectionStart(lines[j]!)) j += 1;
    let end = j;
    while (end > i && blank(lines[end - 1]!)) end -= 1;
    const span = lines.slice(i, end);
    const spanLine = (k: number): number => i + k + 1;
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < span.length; k += 1) {
        const t = span[k]!;
        if (t === '') fileLines.push('');
        else if (t[0] === '+') fileLines.push(t.slice(1));
        else parseErr(spanLine(k));
      }
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile(fileLines, '\n', true));
      });
    } else if (kind === 'delete') {
      if (span.length > 0) parseErr(spanLine(0));
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let k = 0;
      let moveTo: string | null = null;
      if (k < span.length && span[k]!.startsWith('*** Move to: ')) {
        moveTo = span[k]!.slice(13).trim();
        k += 1;
      }
      interface Chunk {
        anchor: string | null;
        eof: boolean;
        o: string[];
        n: string[];
        ctx: (number | null)[];
      }
      const chunks: Chunk[] = [];
      let curChunk: Chunk | null = null;
      let afterEof = false;
      while (k < span.length) {
        const t = span[k]!;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          curChunk = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [], ctx: [] };
          chunks.push(curChunk);
          afterEof = false;
          k += 1;
          continue;
        }
        if (t === '*** End of File') {
          if (curChunk === null) parseErr(spanLine(k));
          curChunk.eof = true;
          curChunk = null;
          afterEof = true;
          k += 1;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (curChunk === null) {
            if (chunks.length === 0 && !afterEof) {
              curChunk = { anchor: null, eof: false, o: [], n: [], ctx: [] };
              chunks.push(curChunk);
            } else parseErr(spanLine(k));
          }
          if (t === '' || t[0] === ' ') {
            curChunk!.ctx.push(curChunk!.o.length);
            curChunk!.o.push(t === '' ? '' : t.slice(1));
            curChunk!.n.push(t === '' ? '' : t.slice(1));
          } else if (t[0] === '-') curChunk!.o.push(t.slice(1));
          else {
            curChunk!.ctx.push(null);
            curChunk!.n.push(t.slice(1));
          }
          k += 1;
          continue;
        }
        parseErr(spanLine(k));
      }
      if (chunks.length === 0 && moveTo === null) parseErr(headerLine);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        let { lines: fl, br, final } = splitFile(before);
        let cursor = 0;
        const tiers = ctx.strict ? [0] : [0, 1, 2];
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let foundAt = -1;
            for (const tier of tiers) {
              for (let idx = cursor; idx < fl.length; idx += 1) {
                if (lineEq(fl[idx]!, ch.anchor, tier)) {
                  foundAt = idx;
                  break;
                }
              }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new Fail('no-match', p);
            cursor = foundAt + 1;
          }
          if (ch.o.length === 0) {
            const at = ch.eof ? fl.length : Math.min(cursor, fl.length);
            fl = [...fl.slice(0, at), ...ch.n, ...fl.slice(at)];
            cursor = at + ch.n.length;
          } else {
            let hit: { tier: number; at: number } | null = null;
            for (const tier of tiers) {
              for (let idx = cursor; idx + ch.o.length <= fl.length; idx += 1) {
                let ok = true;
                for (let j = 0; j < ch.o.length; j += 1) {
                  if (!lineEq(fl[idx + j]!, ch.o[j]!, tier)) {
                    ok = false;
                    break;
                  }
                }
                if (!ok) continue;
                if (ch.eof && idx + ch.o.length !== fl.length) continue;
                hit = { tier, at: idx };
                break;
              }
              if (hit !== null) break;
            }
            if (hit === null) throw new Fail('no-match', p);
            fl = replaceAt(fl, hit.at, ch.o, ch.n, ch.ctx, hit.tier);
            cursor = hit.at + ch.n.length;
          }
        }
        const out = joinFile(fl, br, final);
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.now.set(moveTo, out);
          ctx.moves.push({ old: p, new: moveTo });
        } else {
          tree.now.set(p, out);
        }
      });
    }
    i = j;
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const ctx: Ctx = { strict, moves: [] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, ctx);
    else if (kind === 'search-replace') edits = srEdits(lines, ctx);
    else edits = v4aEdits(lines, ctx);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A move that succeeded prints one `R <old> -> <new>` line, replacing that pair's D and A
  // lines, and sorts by <new> (section 2). It prints even when the moved bytes are unchanged.
  for (const m of ctx.moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.new) === null && tree.get(m.new) !== null) {
      const di = rows.findIndex((r) => r.text === `D ${m.old}`);
      const ai = rows.findIndex((r) => r.text === `A ${m.new}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
