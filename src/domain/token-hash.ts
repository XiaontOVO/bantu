import { createHash } from 'node:crypto';

/** Opaque session tokens have high entropy; persist only a one-way SHA-256 digest. */
export function digestOpaqueToken(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}
