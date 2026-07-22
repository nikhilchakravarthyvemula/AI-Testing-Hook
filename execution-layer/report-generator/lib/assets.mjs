// Inline binary assets (screenshots) as data: URIs so the report is ONE
// self-contained file that opens from file:// with no requests (p0-08 §3,
// acceptance 4). A missing/unreadable image becomes null — the caller renders
// nothing rather than a broken <img>.

import fs from 'node:fs';
import path from 'node:path';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

export function dataUri(absPath) {
  try {
    const mime = MIME[path.extname(absPath).toLowerCase()];
    if (!mime) return null;
    return `data:${mime};base64,${fs.readFileSync(absPath).toString('base64')}`;
  } catch {
    return null;
  }
}
