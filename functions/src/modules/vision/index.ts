export { visionReadPlate, visionReadPlateHandler } from './readPlate.js';
export { getVision } from './registry.js';
export { PlateRecognizerProvider, mapReaderResponse, stateFromRegionCode } from './plateRecognizer.adapter.js';
export { MockPlateRecognition } from './mock.adapter.js';
export type { PlateCandidate, PlateReadResult, PlateRecognitionProvider } from './port.js';
