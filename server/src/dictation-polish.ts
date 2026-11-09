import { isSafeReplyBody } from './tts';

export type DictationEdit = { start: number; end: number; kind: 'filler' | 'repeat' | 'correction' | 'whitespace' };
export type DictationPolish = { body: string; reason: 'applied' | 'raw_kept' | 'raw_invalid'; rawLength: number; finalLength: number };
type Word = { text: string; start: number; end: number };

// Deliberately omit 저/그: both can refer to people or things. Never edit quotes.
const fillers = new Set(['어', '음', '아', '뭐지', '뭐냐']);
// Reviewed repetitions only: arbitrary Hangul words may be people's names.
const repeatedWords = new Set(['내일', '오늘', '모레', '자료', '회의', '확인', '일정', '정말', '감사합니다', '부탁드립니다', '전달', '다시']);
const protectedMarkers = ['못', '안', '않', '없', '가능하면', '면', '것 같', '수 있'];
const nativeNumbers = '한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|열한|열두|스무';
const number = `(?:[0-9]{1,6}|${nativeNumbers})`;
const suffix = '(?:에는|으로|까지|부터|에|로|은|는|이|가|을|를|만|도|과|와)?[.,?!]?';

function words(raw: string): Word[] {
  // Safe bodies contain only BMP characters, so these offsets are code points too.
  return [...raw.matchAll(/[^ ]+/gu)].map(m => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
}

function slot(tokens: Word[], index: number, right: boolean): { type: string; last: number } | null {
  const token = tokens[index]?.text;
  if (!token) return null;
  const tail = right ? suffix : '';
  for (const [type, pattern] of [['day', '(?:오늘|내일|모레)'], ['weekday', '(?:월|화|수|목|금|토|일)요일']] as const) {
    if (new RegExp(`^${pattern}${tail}$`, 'u').test(token)) return { type, last: index };
  }
  // The unit must match too: 3명 → 4개 is not a same-slot correction.
  for (const unit of ['시', '개', '명', '건', '번', '장']) {
    let value: string | undefined, last = index;
    const joined = token.match(new RegExp(`^(${number})${unit}${tail}$`, 'u'));
    if (joined) value = joined[1];
    else if (new RegExp(`^${number}$`, 'u').test(token) && new RegExp(`^${unit}${tail}$`, 'u').test(tokens[index + 1]?.text ?? '')) {
      value = token; last++;
    }
    if (value !== undefined) {
      if (unit === '시' && (/^[0-9]+$/.test(value) ? Number(value) > 23 : value === '스무')) return null;
      return { type: unit, last };
    }
  }
  return null;
}

function honorificPrefixEnd(raw: string): number {
  // Token detection ignores whitespace-run length but retains original offsets.
  // Substring matches deliberately include 함께 and attached forms like 님께서는.
  return words(raw).filter(token => /[님씨께]/u.test(token.text)).at(-1)?.end ?? 0;
}

function protectedHonorificEdit(edit: DictationEdit, prefixEnd: number): boolean {
  // A correction label alone is insufficient: validateDictationEdits still
  // requires an exact span from the same-slot grammar before applying it.
  return edit.kind !== 'correction' && edit.start < prefixEnd;
}

function allowedEdits(raw: string): DictationEdit[] {
  if (!isSafeReplyBody(raw) || /['"]/u.test(raw)) return [];
  const tokens = words(raw), edits: DictationEdit[] = [];
  const add = (first: number, last: number, kind: DictationEdit['kind']) => {
    edits.push({ start: tokens[first].start, end: tokens[last + 1]?.start ?? tokens[last].end, kind });
  };
  // Count correction groups before parsing. Unmatched/name/multiple corrections
  // cannot accidentally turn into a shorter, apparently unambiguous correction.
  const groups: Array<{ first: number; last: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text !== '아니' && tokens[i].text !== '말고') continue;
    const first = i;
    if (tokens[i].text === '아니' && tokens[i + 1]?.text === '아니') i++;
    groups.push({ first, last: i });
  }
  const ambiguous = tokens.some(t => /^(?:아니면|아니라|아니고|말고는)/u.test(t.text));
  if (groups.length === 1 && !ambiguous) {
    const marker = groups[0], right = slot(tokens, marker.last + 1, true);
    const matches: number[] = [];
    for (const first of [marker.first - 2, marker.first - 1]) {
      if (first < 0) continue;
      const left = slot(tokens, first, false);
      if (left && right && left.last === marker.first - 1 && left.type === right.type) matches.push(first);
    }
    if (matches.length === 1) add(matches[0], marker.last, 'correction');
  }
  const overlaps = (start: number, end: number) => edits.some(e => start < e.end && e.start < end);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const atStart = tokens.slice(0, i).every(t => fillers.has(t.text));
    const afterClause = i > 0 && /[,.?!]$/u.test(tokens[i - 1].text);
    if (fillers.has(token.text) && (atStart || afterClause) && !overlaps(token.start, token.end)) add(i, i, 'filler');
    else if (repeatedWords.has(token.text) && tokens[i + 1]?.text === token.text && !overlaps(token.start, tokens[i + 1].end)) add(i, i, 'repeat');
  }
  for (const match of raw.matchAll(/ {2,}/gu)) {
    const start = match.index! + 1, end = match.index! + match[0].length;
    if (!overlaps(start, end)) edits.push({ start, end, kind: 'whitespace' });
  }
  const prefixEnd = honorificPrefixEnd(raw);
  return edits.filter(edit => !protectedHonorificEdit(edit, prefixEnd)).sort((a, b) => a.start - b.start);
}

/** Propose deletion spans only; this function never supplies replacement text. */
export function createDictationEdits(raw: string): DictationEdit[] { return allowedEdits(raw); }

function terminalPeriod(body: string): string {
  // A missing question mark is not proof of a statement. Punctuate only reviewed
  // declarative/request endings; ambiguous fragments and all quotes stay intact.
  if (/[.?!]$|[?'"]/u.test(body) || /(?:누가|누구|언제|어디|어떻게|왜|무엇|몇|얼마)/u.test(body)) return body;
  if (/(?:까요|나요|니|냐|는지|인지|을지|ㄹ지|습니까|합니까|죠|지요)$/u.test(body)) return body;
  return /(?:니다|게요|주세요|세요|같아요|겠어요|없어요|있어요|어려워요|좋아요|가능해요|돼요)$/u.test(body) ? `${body}.` : body;
}

/** Revalidate each operation against the grammar, then assemble original spans. */
export function validateDictationEdits(raw: string, edits: readonly DictationEdit[]): string | null {
  if (!isSafeReplyBody(raw) || edits.length > 6) return null;
  const prefixEnd = honorificPrefixEnd(raw);
  if (edits.some(edit => protectedHonorificEdit(edit, prefixEnd))) return null;
  const allowed = allowedEdits(raw), chars = [...raw];
  let end = 0, body = '', correctedLength = 0;
  for (const edit of edits) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < end || edit.end <= edit.start || edit.end > chars.length
      || !allowed.some(e => e.start === edit.start && e.end === edit.end && e.kind === edit.kind)) return null;
    body += chars.slice(end, edit.start).join('');
    if (edit.kind === 'correction') correctedLength += edit.end - edit.start;
    end = edit.end;
  }
  body = terminalPeriod(body + chars.slice(end).join(''));
  const length = [...body].length;
  // A proven self-correction explicitly retracts X; other deletions still count
  // in full against the remaining dictation's floor.
  if (!isSafeReplyBody(body) || length < (chars.length - correctedLength) * 0.70 || length > chars.length + 2) return null;
  for (const marker of protectedMarkers) {
    if (body.split(marker).length < raw.split(marker).length) return null;
  }
  // All unedited characters (including names, digits and units) came directly
  // from increasing raw spans. Only same-slot correction/reviewed repeat/filler
  // spans may remove content; terminalPeriod can add only a final full stop.
  return body;
}

export function polishReplyDictation(input: string): DictationPolish {
  const raw = input.trim(), rawLength = [...raw].length;
  if (!isSafeReplyBody(raw)) return { body: raw, reason: 'raw_invalid', rawLength, finalLength: rawLength };
  const body = validateDictationEdits(raw, createDictationEdits(raw)) ?? raw;
  return { body, reason: body === raw ? 'raw_kept' : 'applied', rawLength, finalLength: [...body].length };
}
