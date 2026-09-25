import { randomUUID } from 'node:crypto';
import { PHOTO_MAX_BYTES } from '../../public/shared/constants.js';

export const PHOTO_BUCKET = 'attendee-photos';
export const PHOTO_UPLOAD_LIMIT = '1500kb'; // parser ceiling; the 1 MiB rule below is the real limit

const SIGNATURES = [
  { ext: 'jpg', contentType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', contentType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
];

// Magic-byte sniff so a renamed or mislabelled file is still rejected.
export function sniffPhoto(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const sig = SIGNATURES.find((s) => s.bytes.every((byte, i) => buffer[i] === byte));
  return sig ? { ext: sig.ext, contentType: sig.contentType } : null;
}

export function newPhotoPath(ext) {
  return `${randomUUID()}.${ext}`;
}

export function photoContentType(path) {
  return path.endsWith('.png') ? 'image/png' : 'image/jpeg';
}

export function photoTooLarge(buffer) {
  return !Buffer.isBuffer(buffer) || buffer.length > PHOTO_MAX_BYTES;
}
