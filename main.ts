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

/** A file as lines, its line break, and whether it ends with one (SPEC section 3). */
interface FileState { lines: string[]; br: string; final: boolean; }
function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
/** A line compared at one tier (SPEC section 5): 0 exact, 1 trailing ws stripped, 2 both sides. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function occurrences(file: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = 0; i + old.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normLine(file[i + j]!, tier) !== normLine(old[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
/** First tier (0..maxTier) where old occurs at least once at or after `from`. */
function findTier(file: string[], old: string[], from: number, maxTier: number): { tier: number; occ: number[] } | null {
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = occurrences(file, old, tier).filter((i) => i >= from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}
/** First line at or after `from` equal to the anchor, at the first tier with one (single line). */
function matchSingle(file: string[], anchor: string, from: number, maxTier: number): number {
  for (let tier = 0; tier <= maxTier; tier++) {
    const a = normLine(anchor, tier);
    for (let i = from; i < file.length; i++) {
      if (normLine(file[i]!, tier) === a) return i;
    }
  }
  return -1;
}
/** Old lines, new lines, and which indices of each are context lines (in order). */
interface ON { o: string[]; n: string[]; oCtx: number[]; nCtx: number[]; }
/** Build the lines that replace a matched occurrence (SPEC section 5). */
function buildReplacement(on: ON, file: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const P = on.o.length > 0 ? leadOf(on.o[0]!) : '';
  const F = at < file.length ? leadOf(file[at]!) : '';
  const ctxFile = new Map<number, string>();
  for (let k = 0; k < on.oCtx.length; k++) ctxFile.set(on.nCtx[k]!, file[at + on.oCtx[k]!]!);
  for (let j = 0; j < on.n.length; j++) {
    if (ctxFile.has(j)) { out.push(ctxFile.get(j)!); continue; }
    let t = on.n[j]!;
    if (tier === 2 && t !== '' && !/^[ \t]*$/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}
/** One body line of a unified hunk or a V4A chunk. kind ' ' context, '-' old, '+' new, '\\' no-newline marker. */
interface BodyLine { kind: string; text: string; }
function onOf(body: BodyLine[]): ON {
  const o: string[] = [];
  const n: string[] = [];
  const oCtx: number[] = [];
  const nCtx: number[] = [];
  for (const b of body) {
    if (b.kind === ' ') { oCtx.push(o.length); nCtx.push(n.length); o.push(b.text); n.push(b.text); }
    else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push(b.text);
  }
  return { o, n, oCtx, nCtx };
}
/** True when a '\' line immediately follows the body's last context or '+' line. */
function backslashAfterLastCtxPlus(body: BodyLine[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i]!.kind === ' ' || body[i]!.kind === '+') last = i;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

/** One hunk of a unified diff section: A is the old start line (1-based), body its lines. */
interface Hunk { a: number; body: BodyLine[]; }
/** One unified diff section, as parsed. dashOld/dashNew: paths set by a ---/+++ pair. */
interface UniSection {
  oldPath: string | null; newPath: string | null;
  dashOld: boolean; dashNew: boolean;
  isCreate: boolean; isDelete: boolean;
  hunks: Hunk[];
}
/** Path from a '--- ' or '+++ ' line: text after 4 chars, up to first tab, trimmed; /dev/null is no file; leading a/ or b/ removed. */
function unifiedPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}
/** Apply a section's hunks to a file state (SPEC section 6). d is the cumulative length delta. */
function applyHunks(f: FileState, hunks: Hunk[], maxTier: number, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const on = onOf(h.body);
    if (on.o.length === 0) {
      let pos = h.a + d;
      if (pos > f.lines.length) pos = f.lines.length;
      if (pos < 0) pos = 0;
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...on.n);
      if (atEnd) f.final = !backslashAfterLastCtxPlus(h.body);
      d += on.n.length;
    } else {
      const found = findTier(f.lines, on.o, 0, maxTier);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = found.occ[0]!;
      let best = Math.abs(at - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < best) { at = p; best = dist; }
      }
      const rep = buildReplacement(on, f.lines, at, found.tier);
      const endsAtEnd = at + on.o.length === f.lines.length;
      f.lines.splice(at, on.o.length, ...rep);
      if (endsAtEnd) f.final = !backslashAfterLastCtxPlus(h.body);
      d += on.n.length - on.o.length;
    }
  }
}
function makeUnifiedEdit(sec: UniSection, maxTier: number): Edit {
  const oldPath = sec.oldPath;
  const newPath = sec.newPath;
  const hunks = sec.hunks;
  let kind: 'create' | 'delete' | 'move' | 'change';
  if (oldPath === null) kind = 'create';
  else if (newPath === null) kind = 'delete';
  else if (sec.isCreate) kind = 'create';
  else if (sec.isDelete) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  return (tree) => {
    const named: string[] = [];
    if (oldPath !== null) named.push(oldPath);
    if (newPath !== null) named.push(newPath);
    for (const p of named) if (!safe(p)) throw new Fail('unsafe', p);
    if (kind === 'create') {
      if (newPath === null) throw new Fail('unsafe', '');
      const np = newPath;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      for (const h of hunks) for (const b of h.body) if (b.kind === '+') plus.push(b.text);
      let noFinal = false;
      outer: for (let hi = hunks.length - 1; hi >= 0; hi--) {
        const h = hunks[hi]!;
        for (let bi = h.body.length - 1; bi >= 0; bi--) {
          if (h.body[bi]!.kind === '+') {
            noFinal = h.body[bi + 1] !== undefined && h.body[bi + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      const content = plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n');
      tree.now.set(np, content);
      return;
    }
    if (kind === 'delete') {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    if (kind === 'move') {
      const op = oldPath!;
      const np = newPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const f = splitFile(tree.get(op)!);
      applyHunks(f, hunks, maxTier, op);
      tree.now.set(np, joinFile(f));
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    const op = oldPath!;
    if (tree.get(op) === null) throw new Fail('missing', op);
    const f = splitFile(tree.get(op)!);
    applyHunks(f, hunks, maxTier, op);
    tree.now.set(op, joinFile(f));
  };
}
/** Parse a unified diff patch into one edit per section (SPEC section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  const maxTier = strict ? 0 : 2;
  let sec: UniSection | null = null;
  let hunk: Hunk | null = null;
  let inBody = false;
  const hasHunk = (): boolean => sec !== null && sec.hunks.length > 0;
  const flushHunk = (): void => {
    if (hunk !== null && sec !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      sec.hunks.push(hunk);
    }
    hunk = null;
    inBody = false;
  };
  const flushSection = (): void => {
    flushHunk();
    if (sec !== null) {
      edits.push(makeUnifiedEdit(sec, maxTier));
      sec = null;
    }
  };
  const startsPlusPlus = (idx: number): boolean => (lines[idx] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (inBody) {
      if (line.startsWith('diff --git ')) { flushSection(); continue; }
      if (line.startsWith('--- ') && startsPlusPlus(i + 1)) { flushSection(); continue; }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        hunk!.body.push({ kind: line === '' ? ' ' : line[0]!, text: line === '' ? '' : line.slice(1) });
        i++;
        continue;
      }
      flushHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      flushSection();
      sec = { oldPath: m[1]!, newPath: m[2]!, dashOld: false, dashNew: false, isCreate: false, isDelete: false, hunks: [] };
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      flushHunk();
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      inBody = true;
      i++;
      continue;
    }
    if (sec !== null && !hasHunk()) {
      if (line.startsWith('--- ')) {
        if (!startsPlusPlus(i + 1)) throw new Exit2(`error: parse ${i + 2}`);
        if (sec.dashOld || sec.dashNew) {
          flushSection();
          sec = { oldPath: unifiedPath(line), newPath: unifiedPath(lines[i + 1]!), dashOld: true, dashNew: true, isCreate: false, isDelete: false, hunks: [] };
          i += 2;
          continue;
        }
        sec.oldPath = unifiedPath(line);
        sec.newPath = unifiedPath(lines[i + 1]!);
        sec.dashOld = true;
        sec.dashNew = true;
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        sec.newPath = unifiedPath(line);
        sec.dashNew = true;
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) { if (!sec.dashOld) sec.oldPath = line.slice('rename from '.length).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { if (!sec.dashNew) sec.newPath = line.slice('rename to '.length).trim(); i++; continue; }
      if (line === 'new file mode' || line.startsWith('new file mode ')) { sec.isCreate = true; i++; continue; }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) { sec.isDelete = true; i++; continue; }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && startsPlusPlus(i + 1)) {
      flushSection();
      sec = { oldPath: unifiedPath(line), newPath: unifiedPath(lines[i + 1]!), dashOld: true, dashNew: true, isCreate: false, isDelete: false, hunks: [] };
      i += 2;
      continue;
    }
    i++;
  }
  flushSection();
  return edits;
}
function makeSREdit(path: string, oldLines: string[], newLines: string[], maxTier: number): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = splitFile(t);
    const found = findTier(f.lines, oldLines, 0, maxTier);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const rep = buildReplacement({ o: oldLines, n: newLines, oCtx: [], nCtx: [] }, f.lines, at, found.tier);
    f.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}
/** Parse a SEARCH/REPLACE patch into one edit per block (SPEC section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const edits: Edit[] = [];
  const maxTier = strict ? 0 : 2;
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '=======') { eqIdx = j; break; }
      if (l.trimEnd() === '<<<<<<< SEARCH' || l.trimEnd() === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    for (let j = eqIdx + 1; j < n; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '>>>>>>> REPLACE') { repIdx = j; break; }
      if (l.trimEnd() === '<<<<<<< SEARCH') throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(makeSREdit(path, oldLines, newLines, maxTier));
    prevPath = path;
    prevReplaceEnd = repIdx;
    i = repIdx + 1;
  }
  return edits;
}
/** One chunk of a V4A Update section: anchor is null when the chunk has none, eof when it ends at the file's end. */
interface V4AChunk { anchor: string | null; body: BodyLine[]; eof: boolean; }
function makeV4AAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}
function makeV4ADelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}
function makeV4AUpdate(path: string, moveTo: string | null, chunks: V4AChunk[], maxTier: number): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(t);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const ai = matchSingle(f.lines, ch.anchor, cursor, maxTier);
        if (ai < 0) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      const on = onOf(ch.body);
      if (on.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...on.n);
        cursor = pos + on.n.length;
      } else {
        const found = findTier(f.lines, on.o, cursor, maxTier);
        if (!found) throw new Fail('no-match', path);
        let at: number;
        if (ch.eof) {
          const eofStart = f.lines.length - on.o.length;
          if (eofStart < cursor || !found.occ.includes(eofStart)) throw new Fail('no-match', path);
          at = eofStart;
        } else {
          at = found.occ[0]!;
        }
        const rep = buildReplacement(on, f.lines, at, found.tier);
        f.lines.splice(at, on.o.length, ...rep);
        cursor = at + rep.length;
      }
    }
    const content = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, content);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, content);
    }
  };
}
/** Parse a V4A patch into one edit per section (SPEC section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const maxTier = strict ? 0 : 2;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) { i++; continue; }
    if (!isSectionStart(line)) throw new Exit2(`error: parse ${i + 1}`);
    const sectionStart = i;
    let path = '';
    let kind: 'add' | 'delete' | 'update';
    if (line.startsWith('*** Add File: ')) { kind = 'add'; path = line.slice('*** Add File: '.length).trim(); }
    else if (line.startsWith('*** Delete File: ')) { kind = 'delete'; path = line.slice('*** Delete File: '.length).trim(); }
    else { kind = 'update'; path = line.slice('*** Update File: '.length).trim(); }
    i++;
    const secLines: Array<{ text: string; idx: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (isSectionStart(l)) break;
      secLines.push({ text: l, idx: i });
      i++;
    }
    while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const { text, idx } of secLines) {
        if (text === '') { fileLines.push(''); continue; }
        if (text.startsWith('+')) { fileLines.push(text.slice(1)); continue; }
        throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(makeV4AAdd(path, fileLines));
      continue;
    }
    if (kind === 'delete') {
      if (secLines.length > 0) throw new Exit2(`error: parse ${secLines[0]!.idx + 1}`);
      edits.push(makeV4ADelete(path));
      continue;
    }
    let moveTo: string | null = null;
    let rest = secLines;
    if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
      moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
      rest = rest.slice(1);
    }
    const chunks: V4AChunk[] = [];
    let cur: V4AChunk | null = null;
    for (const { text, idx } of rest) {
      if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
        if (!cur) {
          if (chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
          cur = { anchor: null, body: [], eof: false };
        }
        cur.body.push({ kind: text === '' ? ' ' : text[0]!, text: text === '' ? '' : text.slice(1) });
        continue;
      }
      if (text.startsWith('@@')) {
        if (cur) { chunks.push(cur); cur = null; }
        cur = { anchor: text.slice(2).trim(), body: [], eof: false };
        continue;
      }
      if (text.trimEnd() === '*** End of File') {
        if (!cur) throw new Exit2(`error: parse ${idx + 1}`);
        cur.eof = true;
        chunks.push(cur);
        cur = null;
        continue;
      }
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    if (cur) chunks.push(cur);
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sectionStart + 1}`);
    edits.push(makeV4AUpdate(path, moveTo, chunks, maxTier));
  }
  return edits;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, in the order their edits ran. */
  readonly moves: Array<[string, string]> = [];
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
      : v4aEdits(lines, strict);
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
  const changed = new Map<string, { was: string | null; now: string | null }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { was, now });
  }
  const rLines = new Map<string, string>();
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (o === undefined || n === undefined) continue;
    if (o.was === null || o.now !== null) continue;
    if (n.was !== null || n.now === null) continue;
    rLines.set(newP, `R ${oldP} -> ${newP}`);
    consumed.add(oldP);
    consumed.add(newP);
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const [p, c] of changed) {
    if (consumed.has(p)) continue;
    rows.push({ key: p, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, line] of rLines) rows.push({ key: newP, line });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const [p, c] of changed) {
      if (c.now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, c.now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
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
