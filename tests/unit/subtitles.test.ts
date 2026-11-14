import { describe, expect, it } from 'vitest';
import { resolveLanguagePriority, toIso6392 } from '../../src/services/subtitle-matching/languages.js';
import { rankSubtitles, releaseSimilarity, scoreSubtitle } from '../../src/services/subtitle-matching/subtitle-matcher.js';
import { makeSubtitle } from '../helpers/factories.js';

const FILE = { filename: 'Movie.2020.1080p.BluRay.x264-SPARKS.mkv' };

describe('subtitle language prioritization', () => {
  it('returns Croatian first, then English, regardless of score', () => {
    const subs = [
      makeSubtitle({ language: 'en', hashMatch: true, downloadCount: 100_000 }),
      makeSubtitle({ language: 'hr', downloadCount: 1 }),
    ];
    const ranked = rankSubtitles(subs, ['hr', 'en'], FILE, 3);
    expect(ranked.map((r) => r.subtitle.language)).toEqual(['hr', 'en']);
  });

  it('drops languages the user did not ask for', () => {
    const ranked = rankSubtitles([makeSubtitle({ language: 'de' })], ['hr', 'en'], FILE, 3);
    expect(ranked).toHaveLength(0);
  });

  it('resolves "original" to the title language, or skips it when unknown', () => {
    expect(resolveLanguagePriority(['hr', 'en', 'original'], 'ja')).toEqual(['hr', 'en', 'ja']);
    expect(resolveLanguagePriority(['hr', 'en', 'original'], undefined)).toEqual(['hr', 'en']);
    expect(resolveLanguagePriority(['en', 'original'], 'en')).toEqual(['en']);
  });

  it('limits the number of subtitles per language', () => {
    const subs = Array.from({ length: 6 }, (_, i) => makeSubtitle({ language: 'hr', release: `Release.${i}` }));
    expect(rankSubtitles(subs, ['hr'], FILE, 2)).toHaveLength(2);
  });

  it('maps to ISO 639-2 codes for Stremio', () => {
    expect(toIso6392('hr')).toBe('hrv');
    expect(toIso6392('en')).toBe('eng');
  });
});

describe('subtitle release matching', () => {
  it('prefers an exact file-hash match', () => {
    const hash = makeSubtitle({ hashMatch: true, release: 'Something.Else' });
    const named = makeSubtitle({ release: 'Movie.2020.1080p.BluRay.x264-SPARKS' });
    const ranked = rankSubtitles([named, hash], ['en'], FILE, 5);
    expect(ranked[0]?.subtitle.id).toBe(hash.id);
  });

  it('prefers the subtitle made for the same release', () => {
    const exact = makeSubtitle({ release: 'Movie.2020.1080p.BluRay.x264-SPARKS' });
    const other = makeSubtitle({ release: 'Movie.2020.720p.WEB-DL.x264-OTHER', downloadCount: 50_000 });
    const ranked = rankSubtitles([other, exact], ['en'], FILE, 5);
    expect(ranked[0]?.subtitle.id).toBe(exact.id);
  });

  it('penalises a 25 fps subtitle for a film-rate Blu-ray file', () => {
    const pal = scoreSubtitle(makeSubtitle({ release: 'Movie.2020.DVDRip', fps: 25 }), FILE);
    const film = scoreSubtitle(makeSubtitle({ release: 'Movie.2020.DVDRip', fps: 23.976 }), FILE);
    expect(film).toBeGreaterThan(pal);
  });

  it('penalises machine-translated subtitles', () => {
    const human = scoreSubtitle(makeSubtitle({}), FILE);
    const machine = scoreSubtitle(makeSubtitle({ machineTranslated: true }), FILE);
    expect(human).toBeGreaterThan(machine);
  });

  it('measures release-name similarity', () => {
    expect(releaseSimilarity('Movie.2020.1080p.WEB', 'movie 2020 1080p web')).toBe(1);
    expect(releaseSimilarity('Movie.2020.1080p', 'Other.Film.DVDRip')).toBe(0);
    expect(releaseSimilarity(undefined, 'x')).toBe(0);
  });
});

describe('subtitle de-duplication', () => {
  it('removes repeated file ids and repeated releases in the same language', () => {
    const a = makeSubtitle({ id: '1', release: 'Movie.2020.1080p' });
    const sameId = makeSubtitle({ id: '1', release: 'different name' });
    const sameRelease = makeSubtitle({ id: '2', release: 'movie 2020 1080p' });
    const ranked = rankSubtitles([a, sameId, sameRelease], ['en'], FILE, 10);
    expect(ranked).toHaveLength(1);
  });
});
