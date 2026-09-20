/**
 * Image handling for the dashboard.
 *
 * Staff upload photos straight off a phone, which routinely means a 4 MB,
 * 4000px JPEG for a portrait that renders at 400px. Resizing in the browser
 * before the upload — rather than on the server — keeps the API free of native
 * image dependencies, and means the slow part (the upload itself) is already
 * working with a file two orders of magnitude smaller.
 *
 * WebP is used where the browser can encode it, with a JPEG fallback.
 */

import { ApiError } from './api';

export type ResizeOptions = {
  /** Longest edge of the output, in CSS pixels. */
  maxEdge?: number;
  quality?: number;
};

export const IMAGE_PRESETS = {
  /** Doctor portraits: shown at most ~480px wide, on a 2x screen. */
  portrait: { maxEdge: 960, quality: 0.82 },
  /** Blog covers and service art run full width of a content column. */
  cover: { maxEdge: 1600, quality: 0.8 },
} satisfies Record<string, ResizeOptions>;

const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];

export class ImageError extends Error {}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ImageError('That file could not be opened as an image.'));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Scales an image down to fit `maxEdge` and re-encodes it. Images already
 * smaller than the target are not scaled up, only re-encoded.
 */
export async function resizeImage(file: File, options: ResizeOptions = {}): Promise<Blob> {
  const { maxEdge = 1600, quality = 0.82 } = options;

  if (!ACCEPTED.includes(file.type)) {
    throw new ImageError('Please choose a JPEG, PNG or WebP image.');
  }

  const image = await loadImage(file);
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(image.naturalWidth * scale);
  canvas.height = Math.round(image.naturalHeight * scale);

  const context = canvas.getContext('2d');
  if (!context) throw new ImageError('This browser cannot process images. Try a different browser.');

  // White backdrop so a transparent PNG does not become a black rectangle
  // once it is flattened into a photo format.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const webp = await canvasToBlob(canvas, 'image/webp', quality);
  if (webp) return webp;

  const jpeg = await canvasToBlob(canvas, 'image/jpeg', quality);
  if (jpeg) return jpeg;

  throw new ImageError('That image could not be processed. Please try another file.');
}

export type UploadResult = { url: string; bytes: number; type: string };

/**
 * Resizes then uploads, returning the public URL to store on the record.
 *
 * `fetch` is used directly rather than the JSON helper in api.ts because this
 * sends multipart form data; the bearer token is passed the same way.
 */
export async function uploadImage(
  file: File,
  token: string | null,
  options: ResizeOptions = IMAGE_PRESETS.cover,
): Promise<UploadResult> {
  const blob = await resizeImage(file, options);
  const form = new FormData();
  form.append('file', blob, 'upload.webp');

  const response = await fetch(`${import.meta.env.VITE_API_BASE ?? ''}/api/uploads`, {
    method: 'POST',
    credentials: 'include',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });

  const payload = (await response.json().catch(() => ({}))) as { url?: string; message?: string; bytes?: number; type?: string };

  // An HTTP failure is reported as an ApiError, not an ImageError: the caller
  // in useSession refreshes and retries on a 401, and would otherwise show
  // "the upload failed" to someone whose access token had merely expired.
  if (!response.ok) {
    throw new ApiError(response.status, payload.message || 'The upload failed. Please try again.');
  }
  if (!payload.url) {
    throw new ImageError('The upload did not return an image address. Please try again.');
  }

  return { url: payload.url, bytes: payload.bytes ?? blob.size, type: payload.type ?? blob.type };
}

/** "1.4 MB" / "312 KB", for the size hint next to a chosen file. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}
