import type { PlateReadResult, PlateRecognitionProvider } from './port.js';

/**
 * Deterministic provider for the emulator, the seed script and tests: returns a scripted result
 * regardless of the bytes. Never used for a real operator — `getVision` only constructs it under
 * the emulator-only demo switch (lib/demoProviders.ts), which a deployed function cannot enable.
 */
export class MockPlateRecognition implements PlateRecognitionProvider {
  constructor(private readonly result: PlateReadResult = { plate: 'ABC123', state: 'IN', confidence: 0.91, candidates: [{ plate: 'ABC123', confidence: 0.91 }, { plate: 'A8C123', confidence: 0.06 }] }) {}
  readPlate(): Promise<PlateReadResult> {
    return Promise.resolve(this.result);
  }
}
