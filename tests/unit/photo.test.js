import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newPhotoPath, PHOTO_BUCKET, photoContentType, sniffPhoto } from '../../src/services/photo.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

test('sniffs JPEG and PNG by magic bytes, rejects anything else', () => {
  assert.deepEqual(sniffPhoto(JPEG), { ext: 'jpg', contentType: 'image/jpeg' });
  assert.deepEqual(sniffPhoto(PNG), { ext: 'png', contentType: 'image/png' });
  assert.equal(sniffPhoto(GIF), null);
  assert.equal(sniffPhoto(Buffer.from('<html>')), null);
  assert.equal(sniffPhoto(Buffer.alloc(0)), null);
  assert.equal(sniffPhoto(undefined), null);
});

test('photo paths are uuid.ext and carry a matching content type', () => {
  const path = newPhotoPath('png');
  assert.match(path, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
  assert.equal(photoContentType(path), 'image/png');
  assert.equal(photoContentType(newPhotoPath('jpg')), 'image/jpeg');
  assert.notEqual(newPhotoPath('jpg'), newPhotoPath('jpg'));
});

test('bucket name stays in one place', () => {
  assert.equal(PHOTO_BUCKET, 'attendee-photos');
});
