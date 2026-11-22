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

/** Split a file's text into its lines, its line break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

/** Join lines back with the file's own break; a file of no lines is written empty. */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/** One line of N: a context line names its index in O, an added line has ctx null (SPEC.md section 5). */
interface NLine {
  text: string;
  ctx: number | null;
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position where O occurs in the file's lines at one tier; occurrences may overlap. */
function occurrences(fileLines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0 || k > fileLines.length) return out;
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + k <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (normLine(fileLines[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) with an occurrence at or after `from`. */
function findTier(
  fileLines: string[],
  o: string[],
  strict: boolean,
  from = 0,
  eofOnly = false,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(fileLines, o, t).filter((i) => i >= from);
    if (eofOnly) pos = pos.filter((i) => i + o.length === fileLines.length);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** Replace O at `pos` by N: context lines are the file's own, tier 2 re-indents the rest. */
function applyAt(fileLines: string[], pos: number, o: string[], n: NLine[], tier: number): string[] {
  const out = fileLines.slice(0, pos);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = /^[ \t]*/.exec(fileLines[pos]!)![0];
    p = /^[ \t]*/.exec(o[0]!)![0];
  }
  for (const nl of n) {
    if (nl.ctx !== null) {
      out.push(fileLines[pos + nl.ctx]!);
    } else {
      let t = nl.text;
      if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  out.push(...fileLines.slice(pos + o.length));
  return out;
}

/** One unified hunk: A from its header, O and N in body order, and the `\` line facts. */
interface Hunk {
  a: number;
  o: string[];
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (for created files). */
  plusNoEol: boolean;
  hasPlus: boolean;
}

function parseHunkBody(body: string[]): Omit<Hunk, 'a'> {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxPlus = i;
    if (l.startsWith('+')) lastPlus = i;
  }
  const followsBackslash = (i: number): boolean => i >= 0 && body[i + 1] !== undefined && body[i + 1]!.startsWith('\\');
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l === '' || l.startsWith(' ')) {
      const text = l === '' ? '' : l.slice(1);
      o.push(text);
      n.push({ text, ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: null });
    }
  }
  return { o, n, noEol: followsBackslash(lastCtxPlus), plusNoEol: followsBackslash(lastPlus), hasPlus: lastPlus >= 0 };
}

interface Section {
  minus: string | null | undefined;
  plus: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** Remove surrounding spaces only (SPEC.md says "spaces" for paths and anchors, "whitespace" elsewhere). */
function trimSpaces(s: string): string {
  return s.replace(/^ +/, '').replace(/ +$/, '');
}

/** A `--- ` or `+++ ` header line's path: after the four characters, to the first tab, spaces trimmed. */
function headerPath(l: string): string | null {
  let p = trimSpaces(l.slice(4).split('\t')[0]!);
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function freshSection(diffOld?: string, diffNew?: string): Section {
  return { minus: undefined, plus: undefined, renameFrom: undefined, renameTo: undefined, diffOld, diffNew, newFile: false, delFile: false, hunks: [] };
}

function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur !== null) sections.push(cur);
      cur = freshSection(m[1], m[2]);
      inHeader = true;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        if (cur !== null) sections.push(cur);
        cur = freshSection();
        inHeader = true;
      }
      cur.minus = headerPath(l);
      cur.plus = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          j += 1;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a: parseInt(m[1]!, 10), ...parseHunkBody(body) });
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('+++ ')) {
        cur.plus = headerPath(l);
        i += 1;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice('rename from '.length);
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice('rename to '.length);
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  if (cur !== null) sections.push(cur);
  return sections.map((s) => unifiedSectionEdit(s, strict, moves));
}

function unifiedSectionEdit(s: Section, strict: boolean, moves: [string, string][]): Edit {
  const oldPath = s.minus !== undefined ? s.minus : s.renameFrom !== undefined ? s.renameFrom : s.diffOld !== undefined ? s.diffOld : null;
  const newPath = s.plus !== undefined ? s.plus : s.renameTo !== undefined ? s.renameTo : s.diffNew !== undefined ? s.diffNew : null;
  const wantCreate = oldPath === null || s.newFile;
  const wantDelete = newPath === null || s.delFile;
  if (wantCreate && newPath !== null) {
    const np = newPath;
    const plusLines: string[] = [];
    for (const h of s.hunks) for (const nl of h.n) if (nl.ctx === null) plusLines.push(nl.text);
    let createNoEol = false;
    for (const h of s.hunks) if (h.hasPlus) createNoEol = h.plusNoEol;
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.now.set(np, plusLines.length === 0 ? '' : plusLines.join('\n') + (createNoEol ? '' : '\n'));
    };
  }
  if (wantDelete && oldPath !== null) {
    const op = oldPath;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  if (oldPath === null || newPath === null) return () => undefined;
  const op = oldPath;
  const np = newPath;
  const isMove = op !== np;
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    let { lines, br, final } = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      if (h.o.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, lines.length));
        const wasEnd = at === lines.length;
        lines = applyAt(lines, at, h.o, h.n, 0);
        if (wasEnd) final = !h.noEol;
        d += h.n.length;
      } else {
        const found = findTier(lines, h.o, strict);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        for (const p of found.positions) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const atEnd = best + h.o.length === lines.length;
        lines = applyAt(lines, best, h.o, h.n, found.tier);
        if (atEnd) final = !h.noEol;
        d += h.n.length - h.o.length;
      }
    }
    const out = joinFile(lines, br, final);
    if (isMove) {
      tree.now.set(np, out);
      tree.now.set(op, null);
      moves.push([op, np]);
    } else {
      tree.now.set(op, out);
    }
  };
}

function srBlockEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(before);
    const found = findTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const n = newLines.map((t): NLine => ({ text: t, ctx: null }));
    tree.now.set(path, joinFile(applyAt(lines, found.positions[0]!, oldLines, n, found.tier), br, final));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
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
    for (let j = s - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let end = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srBlockEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

interface RawSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  content: { text: string; no: number }[];
}

interface VChunk {
  anchor: string;
  o: string[];
  n: NLine[];
  eof: boolean;
}

function v4aSectionEdit(s: RawSection, strict: boolean, moves: [string, string][]): Edit {
  const content = [...s.content];
  while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (const c of content) {
      if (c.text === '') fileLines.push('');
      else if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
      else throw new Exit2(`error: parse ${c.no}`);
    }
    const path = s.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.no}`);
    const path = s.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (content.length > 0 && content[0]!.text.startsWith('*** Move to: ')) {
    moveTo = trimSpaces(content[0]!.text.slice('*** Move to: '.length));
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  const closeChunk = (): void => {
    if (curChunk !== null) {
      chunks.push(curChunk);
      curChunk = null;
    }
  };
  for (; idx < content.length; idx++) {
    const c = content[idx]!;
    const l = c.text;
    if (l.startsWith('@@')) {
      closeChunk();
      curChunk = { anchor: trimSpaces(l.slice(2)), o: [], n: [], eof: false };
      continue;
    }
    if (l === '*** End of File') {
      if (curChunk !== null) {
        curChunk.eof = true;
        closeChunk();
      }
      continue;
    }
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (curChunk === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${c.no}`);
        curChunk = { anchor: '', o: [], n: [], eof: false };
      }
      if (l === '' || l.startsWith(' ')) {
        const text = l === '' ? '' : l.slice(1);
        curChunk.o.push(text);
        curChunk.n.push({ text, ctx: curChunk.o.length - 1 });
      } else if (l.startsWith('-')) {
        curChunk.o.push(l.slice(1));
      } else {
        curChunk.n.push({ text: l.slice(1), ctx: null });
      }
      continue;
    }
    throw new Exit2(`error: parse ${c.no}`);
  }
  closeChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.line}`);
  const path = s.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const anchorAt = findTier(lines, [ch.anchor], strict, cursor);
        if (anchorAt === null) throw new Fail('no-match', path);
        cursor = anchorAt.positions[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines = applyAt(lines, at, ch.o, ch.n, 0);
        cursor = at + ch.n.length;
      } else {
        const found = findTier(lines, ch.o, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0]!;
        lines = applyAt(lines, pos, ch.o, ch.n, found.tier);
        cursor = pos + ch.n.length;
      }
    }
    const out = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let i = first + 1; i < last; i++) {
    const l = lines[i]!;
    const no = i + 1;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let p = '';
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      p = trimSpaces(l.slice('*** Add File: '.length));
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      p = trimSpaces(l.slice('*** Delete File: '.length));
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      p = trimSpaces(l.slice('*** Update File: '.length));
    }
    if (kind !== null) {
      if (cur !== null) sections.push(cur);
      cur = { kind, path: p, line: no, content: [] };
    } else if (cur !== null) {
      cur.content.push({ text: l, no });
    } else if (!blank(l)) {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  if (cur !== null) sections.push(cur);
  return sections.map((s) => v4aSectionEdit(s, strict, moves));
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
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
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
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rRows = new Map<string, string>();
  const hidden = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rRows.set(newP, `R ${oldP} -> ${newP}`);
      hidden.add(oldP);
      hidden.add(newP);
    }
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of changed) {
    if (hidden.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, text] of rRows) rows.push({ key: newP, text });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
