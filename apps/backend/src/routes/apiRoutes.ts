import { Router } from 'express';
import fetch from 'node-fetch';
import {
  insertMartyrs,
  getUnrecordedNames,
  getRecordedAudioPaths,
  getPaginatedRecordedSegments,
  checkAndCleanupMissingAudioFiles,
  updateExistingRecordsWithPhonetics
} from '../db';
import { getFileUrl } from '../minio';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { processedDir } from '../config/app';

const router = Router();

// Fetch and store martyrs data
router.get('/fetch-and-store-martyrs', async (req, res) => {
  try {
    const apiResponse = await fetch('https://data.techforpalestine.org/api/v2/killed-in-gaza.min.json');
    if (!apiResponse.ok) throw new Error(`API fetch failed: ${apiResponse.status}`);
    const martyrsData = await apiResponse.json() as any[];
    if (!Array.isArray(martyrsData)) throw new Error('Fetched data not an array.');
    const { insertedCount, skippedCount } = await insertMartyrs(martyrsData);
    res.status(200).json({ message: 'Data sync complete.', totalFetched: martyrsData.length, newlyInserted: insertedCount, skipped: skippedCount });
  } catch (error: any) {
    console.error('Data sync error:', error);
    res.status(500).send(`Data sync error: ${error.message}`);
  }
});

// Get unrecorded names
router.get('/get-unrecorded-names', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 200; // Increased default limit
    const names = await getUnrecordedNames(limit);
    res.status(200).json(names);
  } catch (error: any) {
    console.error('Error fetching unrecorded names:', error);
    res.status(500).send(`Error fetching names: ${error.message}`);
  }
});

// Generate master loop
router.get('/generate-master-loop', async (req, res) => {
  try {
    const audioPaths = await getRecordedAudioPaths();
    if (!audioPaths || audioPaths.length === 0) return res.status(404).send('No recordings for loop.');
    
    const absoluteAudioPaths = audioPaths.map(p => path.resolve(processedDir, p));
    // Check existence of all files before creating list
    for (const p of absoluteAudioPaths) {
        if (!fs.existsSync(p)) {
            console.error(`File not found for concatenation: ${p}`);
            return res.status(500).send(`Error: A file listed for concatenation does not exist: ${path.basename(p)}`);
        }
    }
    const fileListContent = absoluteAudioPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'); // Escape single quotes in paths
    const fileListPath = path.join(processedDir, `concat_list_${Date.now()}.txt`);
    fs.writeFileSync(fileListPath, fileListContent);

    const masterLoopFileName = 'master_loop.wav';
    const masterLoopOutputPath = path.join(processedDir, masterLoopFileName);
    
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(fileListPath)
        .inputFormat('concat')
        .audioCodec('pcm_s16le') // Re-encode to ensure compatibility
        .audioFrequency(22050)
        .audioChannels(1)
        .outputOptions('-hide_banner') // Suppress ffmpeg version banner
        .on('error', (err, stdout, stderr) => { 
            console.error('Loop generation FFmpeg error:', err.message, stderr);
            fs.unlink(fileListPath, () => {}); 
            reject(err); 
        })
        .on('end', () => { 
          fs.unlink(fileListPath, () => {}); 
          console.log('Master loop generated:', masterLoopFileName);
          res.status(200).json({ message: 'Master loop generated.', loopFile: masterLoopFileName });
          resolve();
        })
        .save(masterLoopOutputPath);
    });
  } catch (error: any) {
    console.error('Loop generation error:', error);
    res.status(500).send(`Loop generation error: ${error.message}`);
  }
});

// Get audio file
router.get('/audio/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\') || !/^[a-zA-Z0-9_.-]+$/.test(filename)) {
    return res.status(400).send('Invalid filename.');
  }
  
  try {
    const objectName = `audio/${filename}`;
    const url = await getFileUrl(objectName);
    res.redirect(url);
  } catch (error: any) {
    console.error('Error getting audio file:', error);
    res.status(500).send('Error retrieving audio file.');
  }
});

// Get video file
router.get('/video/:filename', async (req, res) => {
  const { filename } = req.params;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\') || !/^[a-zA-Z0-9_.-]+$/.test(filename)) {
    return res.status(400).send('Invalid filename.');
  }
  
  try {
    const objectName = `video/${filename}`;
    const url = await getFileUrl(objectName);
    res.redirect(url);
  } catch (error: any) {
    console.error('Error getting video file:', error);
    res.status(500).send('Error retrieving video file.');
  }
});

// Get recorded segments
router.get('/recorded-segments', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;
    if (page < 1 || limit < 1 || limit > 100) return res.status(400).json({ message: "Invalid page/limit." });
    const data = await getPaginatedRecordedSegments(page, limit);
    res.status(200).json(data);
  } catch (error: any) {
    console.error('Error fetching segments:', error);
    res.status(500).send(`Error fetching segments: ${error.message}`);
  }
});

// Cleanup missing files
router.get('/cleanup-missing-files', async (req, res) => {
  try {
    const result = await checkAndCleanupMissingAudioFiles(processedDir);
    if (result.success) {
      res.status(200).json({
        message: 'Cleanup completed',
        checkedCount: result.checkedCount,
        missingFilesCount: result.missingFilesCount,
        missingFileIds: result.missingFileIds
      });
    } else {
      res.status(500).json({
        message: 'Cleanup failed',
        error: result.error
      });
    }
  } catch (error: any) {
    console.error('Cleanup error:', error);
    res.status(500).send(`Cleanup error: ${error.message}`);
  }
});

// Update phonetics
router.post('/update-phonetics', async (req, res) => {
  try {
    const result = await updateExistingRecordsWithPhonetics();
    if (result.success) {
      res.status(200).json({ 
        message: 'Phonetic pronunciations updated successfully.',
        updatedCount: result.updatedCount 
      });
    } else {
      res.status(500).json({ 
        message: 'Failed to update phonetic pronunciations.',
        error: result.error 
      });
    }
  } catch (error: any) {
    console.error('Error updating phonetics:', error);
    res.status(500).send(`Error updating phonetics: ${error.message}`);
  }
});

export default router; 