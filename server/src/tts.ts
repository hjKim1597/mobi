const digits = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'] as const;
const nativeOnes = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'] as const;

function sinoNumber(value: number): string {
  if (value === 0) return digits[0];
  if (!Number.isSafeInteger(value) || value < 0 || value >= 1_000_000_000_000) return String(value);
  const small = ['', '십', '백', '천'];
  const large = ['', '만', '억'];
  const groups: number[] = [];
  for (let remaining = value; remaining > 0; remaining = Math.floor(remaining / 10_000)) {
    groups.push(remaining % 10_000);
  }
  return groups
    .map((group, groupIndex) => {
      if (group === 0) return '';
      let out = '';
      for (let place = 3; place >= 0; place -= 1) {
        const digit = Math.floor(group / 10 ** place) % 10;
        if (digit) out += `${digit === 1 && place > 0 ? '' : digits[digit]}${small[place]}`;
      }
      return `${out}${large[groupIndex] ?? ''}`;
    })
    .reverse()
    .join(' ');
}

function nativeNumber(value: number): string {
  if (value < nativeOnes.length) return nativeOnes[value] || digits[0];
  if (value === 20) return '스무';
  if (value < 100) {
    const tens = ['', '열', '스무', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
    const ten = Math.floor(value / 10);
    const one = value % 10;
    if (one === 0) return tens[ten];
    const stems = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
    return `${stems[ten]}${nativeOnes[one]}`;
  }
  return sinoNumber(value);
}

function integerText(raw: string, native = false): string {
  const text = raw.replaceAll(',', '');
  // Beyond the supported twelve-digit range, preserve each digit without Number rounding/exponents.
  if (text.length > 12) return [...text].map(digit => digits[Number(digit)]).join(' ');
  return native ? nativeNumber(Number(text)) : sinoNumber(Number(text));
}

function numberText(raw: string, native = false): string {
  const [whole, fraction] = raw.split('.');
  if (fraction === undefined) return integerText(whole, native);
  return `${integerText(whole)} 점 ${[...fraction].map(digit => digits[Number(digit)]).join(' ')}`;
}

function normalizeNumbers(text: string): string {
  let value = text;
  value = value.replace(/00:00/g, '자정').replace(/12:00/g, '정오');
  value = value.replace(/(^|\s)(오전|오후)?\s*(\d{1,2}):(\d{2})/g, (_match, prefix: string, meridiem: string | undefined, hourText: string, minuteText: string) => {
    const numericHour = Number(hourText);
    const hour = numericHour > 12 ? numericHour % 12 : numericHour;
    const spokenMeridiem = meridiem ?? (numericHour >= 13 ? '오후' : numericHour === 0 ? '오전' : '');
    const minutes = Number(minuteText);
    return `${prefix}${spokenMeridiem ? `${spokenMeridiem} ` : ''}${nativeNumber(hour)} 시${minutes === 0 ? '' : ` ${sinoNumber(minutes)} 분`}`;
  });
  value = value.replace(/(-?\d[\d,]*(?:\.\d+)?)\s*(시간|년|월|일|도|원|%|개|분|km\b)/gi, (_match, raw: string, unit: string) => {
    const negative = raw.startsWith('-');
    const prefix = negative ? (unit === '도' ? '영하 ' : '마이너스 ') : '';
    const label = unit === '%' ? '퍼센트' : unit.toLowerCase() === 'km' ? '킬로미터' : unit;
    return `${prefix}${numberText(negative ? raw.slice(1) : raw, unit === '시간' || unit === '개')} ${label}`;
  });
  value = value.replace(/-(\d[\d,]*(?:\.\d+)?)/g, (_match, raw: string) => `마이너스 ${numberText(raw)}`);
  value = value.replace(/\d[\d,]*(?:\.\d+)?/g, raw => numberText(raw));
  return value;
}

function hasUnsafeActionNumber(text: string): boolean {
  return /[0-9]{7}|(?:^|[^0-9])0[0-9]|[\p{Script=Latin}][0-9]|[0-9][\p{Script=Latin}]/u.test(text);
}

/** Shared admission policy for approved reply bodies and calendar titles. */
export function isSafeReplyBody(text: string): boolean {
  return [...text].length > 0 && [...text].length <= 120
    && /^[\p{Script=Hangul}A-Za-z0-9 .,?!'"]+$/u.test(text)
    && !hasUnsafeActionNumber(text)
    && !/[0-9][.,?!'"]|[.,?!'"][0-9]/u.test(text);
}

/** Produces plain Korean text suitable for passing to a speech synthesis adapter. */
export function sanitizeTtsText(text: string, mode: 'general' | 'reply_readback' = 'general'): string {
  if (mode === 'reply_readback') {
    // Approval readback must not remove quotes, punctuation, or word boundaries.
    // Both action kinds admit their user text with the shared policy first.
    if (!/^[\p{L}\p{M}\p{N} .,?!'"]+$/u.test(text) || hasUnsafeActionNumber(text)) throw Error('Unreadable reply readback');
    return text.replace(/[0-9]+/g, run => integerText(run));
  }
  let value = text
    .replace(/(\d)️⃣/gu, '$1')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ');

  value = normalizeNumbers(value);
  value = value
    .replace(/[#*_`~]/g, ' ')
    .replace(/[:/&→]/g, ' ')
    .replace(/\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200D\uFE0E\uFE0F\u20E3]/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/[^\p{L}\p{N}\s.,!?…-]/gu, ' ')
    .replace(/\s*([.,!?…])\s*/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();

  return value;
}
