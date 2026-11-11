import type { Operator } from '@goldstar/platform';
import type { Deps } from '../../lib/deps.js';
import { demoProvidersEnabled } from '../../lib/demoProviders.js';
import { err } from '../../lib/errors.js';
import { MockPlateRecognition } from './mock.adapter.js';
import type { PlateRecognitionProvider } from './port.js';
import { PlateRecognizerProvider } from './plateRecognizer.adapter.js';

/**
 * Provider dispatch keyed on the OPERATOR's `modules.vision.provider` (contracts VISION_PROVIDERS:
 * 'none' | 'plate_recognizer'). 'none' is the configured-off state and throws failed_precondition —
 * the same code the client already maps to "not available right now" — rather than silently
 * returning an empty read that would look like "no plate in the photo".
 *
 * PLATE_RECOGNIZER_TOKEN is platform-wide (one vendor account), read through deps.secrets like
 * MAPBOX_SERVER_TOKEN; the callable declares it in its `secrets` so the runtime mounts it.
 *
 * Under the emulator-only demo switch (lib/demoProviders.ts) a `plate_recognizer` operator gets the
 * scripted MockPlateRecognition and no token is read. 'none' still throws: the switch fakes the
 * vendor, it does not turn on a feature the operator has configured off.
 */
export function getVision(deps: Deps, op: Operator): PlateRecognitionProvider {
  const provider: string = op.modules.vision.provider;
  switch (provider) {
    case 'plate_recognizer':
      if (demoProvidersEnabled()) return new MockPlateRecognition();
      return new PlateRecognizerProvider(fetch, { token: deps.secrets.get('PLATE_RECOGNIZER_TOKEN'), region: 'us' });
    case 'none':
      throw err('failed_precondition', 'plate OCR is not configured for this operator');
    default:
      throw err('provider_unavailable', `vision provider ${provider}`);
  }
}
