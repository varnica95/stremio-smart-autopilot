/** A subtitle file as returned by a subtitle provider, after normalization. */
export interface SubtitleCandidate {
  /** Provider-scoped unique id (e.g. OpenSubtitles file_id). */
  id: string;
  providerId: string;
  /** ISO 639-1 language code, lower-case. */
  language: string;
  /** Release name the subtitle was made for, if known. */
  release?: string;
  fileName?: string;
  fps?: number;
  /** True when the provider says the subtitle was matched to this exact file by hash. */
  hashMatch: boolean;
  downloadCount: number;
  hearingImpaired: boolean;
  machineTranslated: boolean;
  fromTrustedUploader: boolean;
  /** Where the subtitle file can be fetched by the player. */
  url: string;
}

export interface VideoFileHints {
  /** OpenSubtitles hash computed by Stremio for the selected file. */
  videoHash?: string;
  videoSize?: number;
  filename?: string;
}

export interface RankedSubtitle {
  subtitle: SubtitleCandidate;
  score: number;
  languageRank: number;
}
