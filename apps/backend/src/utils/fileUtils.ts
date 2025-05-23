import fs from 'fs';

// Safe file deletion wrapper
export const safeUnlink = (filePath: string) => {
  fs.unlink(filePath, err => {
    if (err && err.code !== 'ENOENT') {
      console.error(`[${new Date().toISOString()}] File deletion error for ${filePath}:`, err);
    }
  });
}; 