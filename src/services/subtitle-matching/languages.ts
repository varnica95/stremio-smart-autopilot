/**
 * ISO 639-1 → ISO 639-2 codes. Stremio shows a language name for subtitle `lang` values that are
 * valid ISO 639-2 codes, and matches them against the player's default-subtitle-language setting.
 */
const ISO_639_2: Record<string, string> = {
  hr: 'hrv',
  en: 'eng',
  sr: 'srp',
  bs: 'bos',
  sl: 'slv',
  mk: 'mac',
  sq: 'alb',
  de: 'ger',
  fr: 'fre',
  es: 'spa',
  it: 'ita',
  pt: 'por',
  nl: 'dut',
  pl: 'pol',
  cs: 'cze',
  sk: 'slo',
  hu: 'hun',
  ro: 'rum',
  bg: 'bul',
  ru: 'rus',
  uk: 'ukr',
  tr: 'tur',
  el: 'gre',
  ar: 'ara',
  he: 'heb',
  zh: 'chi',
  ja: 'jpn',
  ko: 'kor',
  sv: 'swe',
  no: 'nor',
  da: 'dan',
  fi: 'fin',
  hi: 'hin',
  fa: 'per',
  vi: 'vie',
  th: 'tha',
  id: 'ind',
  ms: 'may',
};

export function toIso6392(code: string): string {
  return ISO_639_2[code.toLowerCase()] ?? code.toLowerCase();
}

/**
 * Expands the user's language list: "original" becomes the title's original language when it is
 * known, and is dropped otherwise. Duplicates are removed while keeping priority order.
 */
export function resolveLanguagePriority(preferred: string[], originalLanguage: string | undefined): string[] {
  const out: string[] = [];
  for (const code of preferred) {
    const resolved = code === 'original' ? originalLanguage : code;
    if (resolved && /^[a-z]{2}$/.test(resolved) && !out.includes(resolved)) out.push(resolved);
  }
  return out;
}
