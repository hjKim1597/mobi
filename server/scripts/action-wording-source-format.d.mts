export type ActionWordingSourceAsset = {
  model: string;
  lang: string;
  version: string;
  text: string;
  data: string;
  sha256: string;
  sampleRate: number;
  sourceAttempt: number;
  sourceSha256: string;
  sourceSampleRate: number;
  resample: string;
};

export function parseEmbeddedActionWording(source: string): Record<string, ActionWordingSourceAsset>;
export function renderActionWordingSource(assets: Record<string, ActionWordingSourceAsset>): string;
export function validateActionWordingSource(
  source: string,
  expectedTexts: Record<string, string>,
): Record<string, ActionWordingSourceAsset>;
