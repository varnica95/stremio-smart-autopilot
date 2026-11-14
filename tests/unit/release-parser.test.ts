import { describe, expect, it } from 'vitest';
import {
  parseAudioCodecs,
  parseReleaseName,
  parseResolution,
  parseSeeders,
  parseSize,
  resolutionFromHeight,
} from '../../src/core/parsing/release-parser.js';

describe('release parser', () => {
  it('reads resolution, codecs, source, HDR and group from a scene name', () => {
    const r = parseReleaseName('Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-FraMeSToR.mkv');
    expect(r.resolution).toBe('2160p');
    expect(r.videoCodec).toBe('hevc');
    expect(r.source).toBe('remux');
    expect(r.hdr).toEqual(['DV', 'HDR10']);
    expect(r.audioCodecs).toContain('truehd');
    expect(r.releaseGroup).toBe('FraMeSToR');
  });

  it('recognises common WEB release formats', () => {
    const r = parseReleaseName('Show.S01E05.1080p.WEB-DL.DDP5.1.H.264-NTb');
    expect(r).toMatchObject({ resolution: '1080p', videoCodec: 'h264', source: 'web-dl', releaseGroup: 'NTb' });
    expect(r.audioCodecs).toEqual(['eac3']);
  });

  it('flags low-quality cinema captures', () => {
    expect(parseReleaseName('Movie.2024.HDCAM.x264').source).toBe('cam');
    expect(parseReleaseName('Movie.2024.HDTS.720p').source).toBe('telesync');
  });

  it('does not mistake the .ts file extension for a telesync release', () => {
    expect(parseReleaseName('Movie.2020.1080p.BluRay.x264.ts').source).toBe('bluray');
  });

  it('does not match tokens inside other words', () => {
    expect(parseResolution('Hardcore.Henry.2015')).toBe('unknown');
    expect(parseAudioCodecs('Midtsummer.Night')).toEqual([]);
  });

  it('prefers DTS-HD over plain DTS', () => {
    expect(parseAudioCodecs('Movie.1080p.BluRay.DTS-HD.MA.5.1')).toEqual(['dts-hd']);
  });

  it('parses human-readable sizes', () => {
    expect(parseSize('💾 4.2 GB')).toBe(4_200_000_000);
    expect(parseSize('size 700MB')).toBe(700_000_000);
    expect(parseSize('1,5 GiB')).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseSize('no size here')).toBeUndefined();
  });

  it('parses seeder counts from typical addon labels', () => {
    expect(parseSeeders('👤 123 💾 2 GB')).toBe(123);
    expect(parseSeeders('Seeders: 45')).toBe(45);
    expect(parseSeeders('S: 12')).toBe(12);
    expect(parseSeeders('Show.S01E05.1080p')).toBeUndefined();
    expect(parseSeeders('nothing')).toBeUndefined();
  });

  it('maps pixel heights to standard resolutions', () => {
    expect(resolutionFromHeight(1080)).toBe('1080p');
    expect(resolutionFromHeight(800)).toBe('720p');
    expect(resolutionFromHeight(2160)).toBe('2160p');
    expect(resolutionFromHeight(undefined)).toBe('unknown');
  });
});
