import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * Image uploads for the dashboard (doctor portraits, blog covers, service art).
 *
 * The browser resizes and converts to WebP before sending — see
 * `frontend/src/lib/images.ts` — so by the time a file arrives it is already
 * small. Nothing here trusts that, because the client is not the only possible
 * caller: the filename, the declared MIME type and the extension are all
 * attacker-controlled, so the only thing we believe is the first few bytes of
 * the file itself.
 */

// Held in memory: files are capped well below the JSON body limit and never
// touch disk until they have been sniffed and given a name we generated.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many uploads. Please wait a few minutes.' },
});

/**
 * Magic-byte sniffing. An SVG would also be a valid "image" but is a script
 * execution vector when served from our own origin, so it is deliberately not
 * on this list.
 */
function sniffImage(buffer) {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}

router.post('/', requireAuth('admin'), uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file?.buffer?.length) {
    return res.status(400).json({ message: 'Please choose an image to upload.' });
  }

  const kind = sniffImage(req.file.buffer);
  if (!kind) {
    return res.status(400).json({
      message: 'That file is not a JPEG, PNG or WebP image. Please choose a photo.',
    });
  }

  // The name is generated, never derived from the upload, so path traversal
  // and double-extension tricks have nothing to work with.
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}.${kind.ext}`;

  await fs.mkdir(config.uploadDir, { recursive: true });
  await fs.writeFile(path.join(config.uploadDir, name), req.file.buffer);

  return res.status(201).json({
    url: `/uploads/${name}`,
    bytes: req.file.buffer.length,
    type: kind.mime,
  });
});

/** Multer rejects oversized files by throwing, which would otherwise be a 500. */
router.use((error, _req, res, next) => {
  if (error?.code === 'LIMIT_FILE_SIZE') {
    const mb = (config.maxUploadBytes / 1_000_000).toFixed(1);
    return res.status(413).json({ message: `That image is too large. The limit is ${mb} MB.` });
  }
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ message: 'That upload could not be read. Please try another file.' });
  }
  return next(error);
});

export default router;
