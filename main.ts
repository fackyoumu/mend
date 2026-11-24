// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

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

/** A file as lines: its own line break, the lines, and whether it ends with a break. */
interface FileModel {
  br: '\r\n' | '\n';
  lines: string[];
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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

function loadModel(tree: Tree, p: string): FileModel | null {
  const t = tree.get(p);
  return t === null ? null : parseFile(t);
}

function storeModel(tree: Tree, p: string, m: FileModel): void {
  tree.now.set(p, renderFile(m));
}

// Section 5: matching lines at three tiers.

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  outer: for (let i = from; i + o.length <= lines.length; i++) {
    for (let k = 0; k < o.length; k++) if (!lineEq(lines[i + k]!, o[k]!, tier)) continue outer;
    res.push(i);
  }
  return res;
}

/** The first tier (0 only when strict) with an occurrence at or after `from`; eofOnly keeps occurrences ending at the last line. */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; at: number[] } | null {
  for (const t of strict ? [0] : [0, 1, 2]) {
    let at = occurrences(lines, o, t, from);
    if (eofOnly) at = at.filter((i) => i + o.length === lines.length);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One body line of a hunk or chunk: context, deletion or addition; noNl is set by a following `\` line. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNl: boolean;
  emptyRaw: boolean;
}

function splitON(body: BodyLine[]): { o: string[]; n: string[]; nCtx: (number | null)[] } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      nCtx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'del') {
      o.push(b.text);
    } else {
      n.push(b.text);
      nCtx.push(null);
    }
  }
  return { o, n, nCtx };
}

/** Replace the o.length lines at pos by the body's new lines: context comes from the file, tier 2 re-indents additions. */
function applyBody(lines: string[], pos: number, o: string[], n: string[], nCtx: (number | null)[], tier: number): string[] {
  const out: string[] = [];
  for (let k = 0; k < n.length; k++) {
    const ctxAt = nCtx[k]!;
    if (ctxAt !== null) {
      out.push(lines[pos + ctxAt]!);
    } else {
      let s = n[k]!;
      if (tier === 2 && o.length > 0 && s.trim() !== '') {
        const f = leadingWs(lines[pos]!);
        const p = leadingWs(o[0]!);
        if (s.startsWith(p)) s = f + s.slice(p.length);
      }
      out.push(s);
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

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

// Section 6: unified diffs.

interface Hunk {
  a: number;
  body: BodyLine[];
  lastPlusCtxNoNl: boolean;
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  hdrOld?: string | null;
  hdrNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

function hdrPath(l: string): string | null {
  let p = l.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const pairStart = (lines: string[], j: number): boolean =>
  lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');

function parseSectionRest(lines: string[], i: number, sec: Section): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || l.startsWith('@@')) break;
    if (l.startsWith('--- ')) {
      if (sec.hdrOld !== undefined) break;
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      sec.hdrOld = hdrPath(l);
      sec.hdrNew = hdrPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      sec.renameFrom = l.slice('rename from '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.renameTo = l.slice('rename to '.length).trim();
      i++;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.newFile = true;
      i++;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.delFile = true;
      i++;
      continue;
    }
    i++;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || pairStart(lines, i)) break;
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s|$)/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [], lastPlusCtxNoNl: false };
      i++;
      const raw: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || pairStart(lines, i)) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          raw.push(b);
          i++;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      for (const b of raw) {
        if (b.startsWith('\\')) {
          const prev = hunk.body[hunk.body.length - 1];
          if (prev) prev.noNl = true;
        } else if (b === '') hunk.body.push({ kind: 'ctx', text: '', noNl: false, emptyRaw: true });
        else if (b[0] === ' ') hunk.body.push({ kind: 'ctx', text: b.slice(1), noNl: false, emptyRaw: false });
        else if (b[0] === '-') hunk.body.push({ kind: 'del', text: b.slice(1), noNl: false, emptyRaw: false });
        else hunk.body.push({ kind: 'add', text: b.slice(1), noNl: false, emptyRaw: false });
      }
      for (let k = hunk.body.length - 1; k >= 0; k--) {
        if (hunk.body[k]!.kind !== 'del') {
          hunk.lastPlusCtxNoNl = hunk.body[k]!.noNl;
          break;
        }
      }
      sec.hunks.push(hunk);
      continue;
    }
    i++;
  }
  return i;
}

function applyUnifiedHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const { o, n, nCtx } = splitON(h.body);
    if (o.length === 0) {
      let at = h.a + d;
      at = Math.max(0, Math.min(at, model.lines.length));
      const atEnd = at === model.lines.length;
      model.lines = [...model.lines.slice(0, at), ...n, ...model.lines.slice(at)];
      if (atEnd) model.finalBreak = !h.lastPlusCtxNoNl;
      d += n.length;
    } else {
      const found = findTier(model.lines, o, strict, 0, false);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.at[0]!;
      for (const cand of found.at) if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      const runsToEnd = pos + o.length === model.lines.length;
      model.lines = applyBody(model.lines, pos, o, n, nCtx, found.tier);
      if (runsToEnd) model.finalBreak = !h.lastPlusCtxNoNl;
      d += n.length - o.length;
    }
  }
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null | undefined;
    let newP: string | null | undefined;
    if (sec.hdrOld !== undefined) {
      oldP = sec.hdrOld;
      newP = sec.hdrNew;
    } else if (sec.renameFrom !== undefined || sec.renameTo !== undefined) {
      oldP = sec.renameFrom;
      newP = sec.renameTo;
    } else {
      oldP = sec.gitOld;
      newP = sec.gitNew;
    }
    const isCreate = sec.newFile || oldP === null;
    const isDelete = sec.delFile || newP === null;
    if (isCreate && newP != null) {
      const p = newP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      let lastAddNoNl = false;
      for (const h of sec.hunks)
        for (const b of h.body)
          if (b.kind === 'add') {
            outLines.push(b.text);
            lastAddNoNl = b.noNl;
          }
      tree.now.set(p, outLines.length === 0 ? '' : outLines.join('\n') + (lastAddNoNl ? '' : '\n'));
      return;
    }
    if (isDelete && oldP != null) {
      const p = oldP;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const n = newP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (!safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    if (n !== o && tree.get(n) !== null) throw new Fail('exists', n);
    const model = parseFile(before);
    applyUnifiedHunks(model, sec.hunks, strict, o);
    if (n !== o) {
      tree.now.set(o, null);
      tree.now.set(n, renderFile(model));
      tree.moves.push([o, n]);
    } else {
      storeModel(tree, o, model);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*?) b\/(.*)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = { gitOld: m[1]!, gitNew: m[2]!, newFile: false, delFile: false, hunks: [] };
      sections.push(sec);
      i = parseSectionRest(lines, i + 1, sec);
    } else if (pairStart(lines, i)) {
      const sec: Section = { newFile: false, delFile: false, hunks: [] };
      sections.push(sec);
      i = parseSectionRest(lines, i, sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// Section 7: SEARCH/REPLACE blocks.

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const model = loadModel(tree, path);
    if (model === null) throw new Fail('missing', path);
    const found = findTier(model.lines, oldLines, strict, 0, false);
    if (!found) throw new Fail('no-match', path);
    if (found.at.length > 1) throw new Fail('ambiguous', path);
    model.lines = applyBody(model.lines, found.at[0]!, oldLines, newLines, newLines.map(() => null), found.tier);
    storeModel(tree, path, model);
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | undefined;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let mid = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        mid = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (mid >= 0)
      for (let j = mid + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '>>>>>>> REPLACE') {
          end = j;
          break;
        }
        if (t === '<<<<<<< SEARCH') break;
      }
    if (mid < 0 || end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | undefined;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (l.trim() === '' || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(path, lines.slice(searchIdx + 1, mid), lines.slice(mid + 1, end), strict));
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// Section 8: V4A patches.

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  for (const t of strict ? [0] : [0, 1, 2]) {
    for (let i = cursor; i < lines.length; i++) if (lineEq(lines[i]!, anchor, t)) return i;
  }
  return -1;
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const ls = sec.addLines;
      tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const model = loadModel(tree, p);
    if (model === null) throw new Fail('missing', p);
    const dest = sec.moveTo;
    if (dest !== undefined) {
      if (!safe(dest)) throw new Fail('unsafe', dest);
      if (tree.get(dest) !== null) throw new Fail('exists', dest);
    }
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(model.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { o, n, nCtx } = splitON(ch.body);
      if (o.length === 0) {
        const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines = [...model.lines.slice(0, at), ...n, ...model.lines.slice(at)];
        cursor = at + n.length;
      } else {
        const found = findTier(model.lines, o, strict, cursor, ch.eof);
        if (!found) throw new Fail('no-match', p);
        const pos = found.at[0]!;
        model.lines = applyBody(model.lines, pos, o, n, nCtx, found.tier);
        cursor = pos + n.length;
      }
    }
    if (dest !== undefined) {
      tree.now.set(p, null);
      tree.now.set(dest, renderFile(model));
      tree.moves.push([p, dest]);
    } else {
      storeModel(tree, p, model);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !blank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let j = lines.length - 1; j >= 0; j--)
    if (!blank(lines[j]!)) {
      lastIdx = j;
      break;
    }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (!secStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : 'update';
    const sec: VSection = {
      kind,
      path: l.slice(l.indexOf(': ') + 2).trim(),
      lineNo: i + 1,
      addLines: [],
      chunks: [],
    };
    i++;
    if (kind === 'add') {
      const buf: string[] = [];
      while (i < lastIdx && !secStart(lines[i]!)) {
        const b = lines[i]!;
        if (b.startsWith('+')) {
          buf.push(b.slice(1));
          i++;
        } else if (b === '') {
          buf.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (buf.length > 0 && buf[buf.length - 1] === '') buf.pop();
      sec.addLines = buf;
    } else if (kind === 'del') {
      while (i < lastIdx && !secStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
    } else {
      let first = true;
      let cur: VChunk | null = null;
      let curBody: BodyLine[] = [];
      const flush = (eof: boolean): void => {
        if (cur !== null) {
          cur.body = curBody;
          if (eof) cur.eof = true;
          sec.chunks.push(cur);
          cur = null;
          curBody = [];
        }
      };
      while (i < lastIdx && !secStart(lines[i]!)) {
        const b = lines[i]!;
        if (first && b.startsWith('*** Move to: ')) {
          sec.moveTo = b.slice('*** Move to: '.length).trim();
          i++;
          first = false;
          continue;
        }
        first = false;
        if (b.startsWith('@@')) {
          flush(false);
          const anchorText = b.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          curBody = [];
          i++;
          continue;
        }
        if (b.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            curBody = [];
          }
          flush(true);
          i++;
          continue;
        }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) {
          if (cur === null) {
            cur = { anchor: null, eof: false, body: [] };
            curBody = [];
          }
          if (b === '') curBody.push({ kind: 'ctx', text: '', noNl: false, emptyRaw: true });
          else if (b[0] === ' ') curBody.push({ kind: 'ctx', text: b.slice(1), noNl: false, emptyRaw: b.trim() === '' });
          else if (b[0] === '-') curBody.push({ kind: 'del', text: b.slice(1), noNl: false, emptyRaw: false });
          else curBody.push({ kind: 'add', text: b.slice(1), noNl: false, emptyRaw: false });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush(false);
      const lastChunk = sec.chunks[sec.chunks.length - 1];
      if (lastChunk) while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.emptyRaw) lastChunk.body.pop();
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
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
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (consumed.has(o) || consumed.has(n)) continue;
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      consumed.add(o);
      consumed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
