import fs from 'fs';
import path from 'path';
import { processedDir } from '../config/app';

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export const cleanupOldTempDirs = async () => {
  try {
    console.log(`[${new Date().toISOString()}] Starting cleanup of old temporary directories`);
    
    const dirs = fs.readdirSync(processedDir);
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const dir of dirs) {
      const dirPath = path.join(processedDir, dir);
      
      // Skip non-temp directories
      if (!dir.startsWith('temp_') && !dir.startsWith('hls_')) {
        continue;
      }
      
      try {
        const stats = fs.statSync(dirPath);
        const age = now - stats.mtimeMs;
        
        if (age > MAX_AGE_MS) {
          console.log(`[${new Date().toISOString()}] Cleaning up old directory: ${dir} (age: ${Math.round(age / 1000 / 60)} minutes)`);
          fs.rmSync(dirPath, { recursive: true, force: true });
          cleanedCount++;
        }
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Error cleaning up directory ${dir}:`, err);
      }
    }
    
    console.log(`[${new Date().toISOString()}] Cleanup completed. Removed ${cleanedCount} old directories`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error during cleanup:`, err);
  }
};

// Run cleanup every hour
setInterval(cleanupOldTempDirs, 60 * 60 * 1000);

// Run initial cleanup
cleanupOldTempDirs(); 