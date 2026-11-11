/**
 * Plan 8 Task 8 — plate OCR port. One method, one provider-neutral result. The adapter maps a
 * vendor response into this; the callable never sees vendor fields.
 */
export interface PlateCandidate {
  plate: string;
  /** 0..1 */
  confidence: number;
}

export interface PlateReadResult {
  /** Best read, already normalised (uppercase, no whitespace). Absent when nothing was read. */
  plate?: string;
  /** Two-letter US state when the provider reported a region like `us-in`. */
  state?: string;
  /** Confidence of `plate` (0 when nothing was read). */
  confidence: number;
  candidates: PlateCandidate[];
}

export interface PlateRecognitionProvider {
  readPlate(i: { bytes: Buffer; region?: string }): Promise<PlateReadResult>;
}
