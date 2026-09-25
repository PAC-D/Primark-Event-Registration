import express, { Router } from 'express';
import { errors } from '../errors.js';
import {
  newPhotoPath, PHOTO_BUCKET, PHOTO_UPLOAD_LIMIT, photoTooLarge, sniffPhoto,
} from '../services/photo.js';

const TYPE_MESSAGE = 'Please choose a JPG or PNG image.';
const SIZE_MESSAGE = 'Photo must be 1 MB or smaller.';

export function photosRoutes({ db }) {
  const router = Router();
  // Runs instead of express.json for image bodies: create-app's json parser only matches JSON
  // content types, so this raw parser (its own ceiling above the 1 MiB rule) sees every upload.
  router.post(
    '/photos',
    express.raw({ type: ['image/jpeg', 'image/png'], limit: PHOTO_UPLOAD_LIMIT }),
    async (req, res) => {
      const sig = sniffPhoto(req.body);
      if (!sig || sig.contentType !== req.headers['content-type']) {
        throw errors.validation({ photo: TYPE_MESSAGE });
      }
      if (photoTooLarge(req.body)) throw errors.validation({ photo: SIZE_MESSAGE });
      const path = newPhotoPath(sig.ext);
      const { error } = await db.storage
        .from(PHOTO_BUCKET)
        .upload(path, req.body, { contentType: sig.contentType });
      if (error) throw Object.assign(errors.dbUnavailable(), { cause: error });
      res.status(201).json({ path });
    },
  );
  return router;
}
