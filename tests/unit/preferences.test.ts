import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../../src/config/env.js';
import { DEFAULT_PREFERENCES, encodePreferencesForUrl, parsePreferences } from '../../src/config/preferences.js';

describe('user preferences', () => {
  it('has the documented defaults', () => {
    expect(DEFAULT_PREFERENCES).toEqual({
      subtitleLanguages: ['hr', 'en', 'original'],
      preferredResolution: '1080p',
      minResolution: '720p',
      maxResolution: '2160p',
      rankingProfile: 'best-overall',
      preferSmallerFiles: true,
      preferCompatibleAudio: true,
      excludeLowQuality: true,
      maxResults: 10,
      maxSubtitlesPerLanguage: 3,
    });
  });

  it('accepts form-style strings', () => {
    const { prefs, issues } = parsePreferences({
      maxResults: '5',
      preferSmallerFiles: 'false',
      excludeLowQuality: 'on',
      subtitleLanguages: 'EN, hr',
    });
    expect(issues).toEqual([]);
    expect(prefs).toMatchObject({ maxResults: 5, preferSmallerFiles: false, excludeLowQuality: true, subtitleLanguages: ['en', 'hr'] });
  });

  it('falls back to defaults for invalid fields and reports them', () => {
    const { prefs, issues } = parsePreferences({ rankingProfile: 'random', maxResults: 999, preferredResolution: '720p' });
    expect(prefs.rankingProfile).toBe('best-overall');
    expect(prefs.maxResults).toBe(10);
    expect(prefs.preferredResolution).toBe('720p');
    expect(issues).toHaveLength(2);
  });

  it('ignores garbage input entirely', () => {
    expect(parsePreferences(false).prefs).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences('nope').prefs).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ unknownKey: 1 }).prefs).toEqual(DEFAULT_PREFERENCES);
  });

  it('keeps min ≤ preferred ≤ max', () => {
    const { prefs } = parsePreferences({ minResolution: '2160p', maxResolution: '720p', preferredResolution: '480p' });
    expect(prefs.minResolution).toBe('720p');
    expect(prefs.maxResolution).toBe('2160p');
    expect(prefs.preferredResolution).toBe('720p');
  });

  it('accepts a personal OpenSubtitles key and rejects malformed ones', () => {
    expect(parsePreferences({ openSubtitlesApiKey: '  AbCdEf0123456789xyz  ' }).prefs.openSubtitlesApiKey).toBe('AbCdEf0123456789xyz');
    const bad = parsePreferences({ openSubtitlesApiKey: 'short' });
    expect(bad.prefs.openSubtitlesApiKey).toBeUndefined();
    expect(bad.issues[0]).toContain('openSubtitlesApiKey');
    expect(bad.issues[0]).not.toContain('short');
  });

  it('round-trips through the addon URL encoding', () => {
    const encoded = encodePreferencesForUrl({ maxResults: 3, subtitleLanguages: ['hr'] });
    expect(encoded).not.toContain('/');
    expect(parsePreferences(JSON.parse(decodeURIComponent(encoded))).prefs.maxResults).toBe(3);
  });
});

describe('server configuration', () => {
  it('loads defaults from an empty environment', () => {
    const config = loadServerConfig({});
    expect(config.port).toBe(7000);
    expect(config.publicUrl).toBe('http://127.0.0.1:7000');
    expect(config.probe.enabled).toBe(true);
    expect(config.defaultPreferences).toEqual(DEFAULT_PREFERENCES);
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadServerConfig({ PORT: 'abc' })).toThrow(/port/);
    expect(() => loadServerConfig({ UPSTREAM_ADDONS: '[{"id":"x"}]' })).toThrow(/upstreamAddons/);
  });

  it('lets the operator change default preferences', () => {
    const config = loadServerConfig({ DEFAULT_PREFERENCES: '{"subtitleLanguages":["en"],"maxResults":5}' });
    expect(config.defaultPreferences.subtitleLanguages).toEqual(['en']);
    expect(config.defaultPreferences.maxResults).toBe(5);
  });
});
