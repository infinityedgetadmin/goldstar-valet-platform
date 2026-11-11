/**
 * Synthetic placeholder images (generated, no real vehicles, people or venues) used as the demo's vehicle-condition, inspection and incident evidence. Bytes and
 * dimensions are recorded here so the pure dataset builders stay free of filesystem access;
 * dataset.test.ts checks every entry against the file on disk.
 */
export interface DemoPhotoAsset {
  /** File name under scripts/demo/photos/. */
  file: string;
  bytes: number;
  width: number;
  height: number;
}

export const DEMO_PHOTOS: readonly DemoPhotoAsset[] = [
  { file: 'car-1.jpg', bytes: 10_934, width: 640, height: 480 },
  { file: 'car-2.jpg', bytes: 11_997, width: 640, height: 480 },
  { file: 'car-3.jpg', bytes: 11_824, width: 640, height: 480 },
  { file: 'car-4.jpg', bytes: 11_853, width: 640, height: 480 },
  { file: 'car-5.jpg', bytes: 12_246, width: 640, height: 480 },
  { file: 'car-6.jpg', bytes: 12_597, width: 640, height: 480 },
  { file: 'car-7.jpg', bytes: 11_692, width: 640, height: 480 },
  { file: 'car-8.jpg', bytes: 10_727, width: 640, height: 480 },
];

/** Picks a photo deterministically so each report gets a varied but stable set. */
export function demoPhoto(index: number): DemoPhotoAsset {
  const photo = DEMO_PHOTOS[index % DEMO_PHOTOS.length];
  if (!photo) throw new Error('DEMO_PHOTOS is empty');
  return photo;
}
