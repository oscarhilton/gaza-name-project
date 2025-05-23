import { Router } from 'express';
import { upload, videoUpload, chunkUpload, uploadLimiter } from '../config/app';
import { safeUnlink } from '../utils/fileUtils';
import { uploadsDir, processedDir } from '../config/app';
import { markNameAsRecorded, markNameAsUnrecorded, updateProcessedAudioPath, updateProcessedVideoPath } from '../db';
import minioClient, { uploadFile, uploadHLSManifest, uploadHLSSegment, getPresignedUploadUrl } from '../minio';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import pLimit from 'p-limit';

const BUCKET_NAME = 'gaza-name-project';

const router = Router();

// Store for temporary upload chunks with metadata
const uploadChunks = new Map<string, { 
  chunks: Buffer[], 
  totalChunks: number,
  lastActivity: number,
  selectedNameId: number,
  fileName: string
}>();

// Cleanup old chunks periodically
setInterval(() => {
  const now = Date.now();
  for (const [uploadId, data] of uploadChunks.entries()) {
    if (now - data.lastActivity > 3600000) { // 1 hour
      console.log(`[${new Date().toISOString()}] Cleaning up stale upload: ${uploadId}`);
      uploadChunks.delete(uploadId);
    }
  }
}, 300000); // Check every 5 minutes

// Add these utility functions at the top of the file
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryOperation = async <T>(
  operation: () => Promise<T>,
  maxRetries: number,
  delayMs: number,
  operationName: string,
  processId: string
): Promise<T> => {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn(`[${new Date().toISOString()}] [${processId}] ${operationName} attempt ${attempt}/${maxRetries} failed:`, lastError.message);
      
      if (attempt < maxRetries) {
        console.log(`[${new Date().toISOString()}] [${processId}] Retrying ${operationName} in ${delayMs}ms...`);
        await sleep(delayMs);
      }
    }
  }
  
  throw new Error(`${operationName} failed after ${maxRetries} attempts. Last error: ${lastError?.message}`);
};

// Add this utility function at the top
const remuxWebM = async (inputPath: string, outputPath: string, processId: string): Promise<void> => {
  console.log(`[${new Date().toISOString()}] [${processId}] Starting WebM remuxing`);
  
  return new Promise((resolve, reject) => {
    let timeoutTriggered = false;
    
    const ffmpegProcess = ffmpeg(inputPath)
      .inputOptions([
        '-err_detect ignore_err',
        '-fflags +genpts',
        '-analyzeduration 2147483647',
        '-probesize 2147483647'
      ])
      .outputOptions([
        '-c:v copy',
        '-c:a copy',
        '-f webm',
        '-loglevel debug'
      ])
      .output(outputPath)
      .on('start', cmd => {
        console.log(`[${new Date().toISOString()}] [${processId}] FFmpeg remux started:`, cmd);
      })
      .on('progress', progress => {
        console.log(`[${new Date().toISOString()}] [${processId}] Remux progress:`, {
          percent: progress.percent?.toFixed(1),
          frames: progress.frames,
          timemark: progress.timemark
        });
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`[${new Date().toISOString()}] [${processId}] Remux error:`, err.message);
        console.error(`[${new Date().toISOString()}] [${processId}] Remux stderr:`, stderr);
        reject(err);
      })
      .on('end', () => {
        if (timeoutTriggered) return;
        console.log(`[${new Date().toISOString()}] [${processId}] Remux completed`);
        resolve();
      });

    // Set a timeout for remuxing
    setTimeout(() => {
      timeoutTriggered = true;
      if (ffmpegProcess) {
        console.error(`[${new Date().toISOString()}] [${processId}] Remux timed out after 30 seconds`);
        ffmpegProcess.kill('SIGKILL');
        reject(new Error('Remux timed out'));
      }
    }, 30000);
  });
};

// Audio upload route
router.post('/audio', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).send('No audio file uploaded.');
  
  const selectedNameIdString = req.body.selectedNameId;
  if (!selectedNameIdString) {
    fs.unlink(req.file.path, (err) => { if (err) console.error("Error deleting orphaned upload:", err);}); 
    return res.status(400).send('No name ID selected.');
  }
  const selectedNameId = parseInt(selectedNameIdString);
  if (isNaN(selectedNameId)) {
    fs.unlink(req.file.path, (err) => { if (err) console.error("Error deleting upload with invalid ID:", err);});
    return res.status(400).send('Invalid Name ID.');
  }

  const inputPath = req.file.path;
  const outputFileName = `processed_name_${selectedNameId}_${Date.now()}${path.extname(req.file.originalname) || '.wav'}`;
  const outputPath = path.join(processedDir, outputFileName);

  console.log(`Processing upload: ${req.file.originalname} for ID ${selectedNameId} -> ${outputFileName}`);

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec('pcm_s16le')
        .audioFrequency(22050)
        .audioChannels(1)
        .format('wav')
        .on('start', cmd => console.log('FFmpeg started:', cmd))
        .on('error', (err, stdout, stderr) => {
          console.error('FFmpeg error:', err.message);
          console.error('FFmpeg stderr:', stderr);
          reject(err);
        })
        .on('end', async () => {
          console.log('FFmpeg processing finished for:', outputFileName);
          try {
            if (!fs.existsSync(outputPath)) {
              console.error(`Processed file not found: ${outputPath}`);
              await markNameAsUnrecorded(selectedNameId);
              res.status(500).json({ 
                message: 'Audio processing failed - file not found.',
                error: 'Processed file was not created successfully'
              });
              resolve();
              return;
            }

            // Upload to MinIO
            const objectName = `audio/${outputFileName}`;
            await uploadFile(outputPath, objectName, 'audio/wav');
            
            const markResult = await markNameAsRecorded(selectedNameId);
            const pathUpdateResult = await updateProcessedAudioPath(selectedNameId, objectName);
            
            // Clean up local files
            fs.unlinkSync(inputPath);
            fs.unlinkSync(outputPath);
            
            console.log(`DB update for ID ${selectedNameId}: Mark=${markResult.success}, PathUpdate=${pathUpdateResult.success}`);
            res.status(200).json({ 
              message: 'Audio processed & stored in MinIO.', 
              processedFile: objectName,
              dbMarkUpdate: markResult,
              dbPathUpdate: pathUpdateResult
            });
            resolve();
          } catch (dbError: any) {
            console.error('DB error post-processing:', dbError);
            await markNameAsUnrecorded(selectedNameId);
            res.status(500).json({ message: 'Audio processed, DB update failed.', dbError: dbError.message });
            reject(dbError);
          }
        })
        .save(outputPath);
    });
  } catch (processingError: any) {
    console.error('Overall processing/DB error:', processingError.message);
    fs.unlink(inputPath, (err) => {if (err) console.error("Error deleting input file on error:", err);}); 
    await markNameAsUnrecorded(selectedNameId);
    if (!res.headersSent) {
      res.status(500).send(`Processing error: ${processingError.message}`);
    }
  }
});

// Video chunk upload route
router.post('/upload-video-chunk', chunkUpload.single('chunk'), async (req, res) => {
  console.log(`[${new Date().toISOString()}] Received chunk upload request:`, {
    uploadId: req.body.uploadId,
    chunkIndex: req.body.chunkIndex,
    totalChunks: req.body.totalChunks,
    fileName: req.body.fileName,
    chunkSize: req.file?.size
  });

  if (!req.file) {
    console.error(`[${new Date().toISOString()}] No chunk uploaded`);
    return res.status(400).json({ message: 'No chunk uploaded' });
  }

  const { uploadId, chunkIndex, totalChunks, selectedNameId, fileName } = req.body;
  if (!uploadId || !chunkIndex || !totalChunks || !selectedNameId || !fileName) {
    console.error(`[${new Date().toISOString()}] Missing required fields:`, { uploadId, chunkIndex, totalChunks, selectedNameId, fileName });
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    // Initialize or get existing chunks
    if (!uploadChunks.has(uploadId)) {
      console.log(`[${new Date().toISOString()}] Initializing new upload tracking:`, {
        uploadId,
        totalChunks,
        selectedNameId,
        fileName
      });
      uploadChunks.set(uploadId, {
        chunks: new Array(parseInt(totalChunks)).fill(null),
        totalChunks: parseInt(totalChunks),
        lastActivity: Date.now(),
        selectedNameId: parseInt(selectedNameId),
        fileName
      });
    }

    const upload = uploadChunks.get(uploadId)!;
    upload.lastActivity = Date.now();
    upload.chunks[parseInt(chunkIndex)] = req.file.buffer;

    // Check if all chunks are received
    const isComplete = upload.chunks.every(chunk => chunk !== null);
    const receivedChunks = upload.chunks.filter(Boolean).length;
    
    console.log(`[${new Date().toISOString()}] Chunk upload status:`, {
      uploadId,
      chunkIndex,
      receivedChunks,
      totalChunks: upload.totalChunks,
      isComplete
    });

    res.status(200).json({
      message: 'Chunk uploaded successfully',
      isComplete,
      receivedChunks,
      totalChunks: upload.totalChunks,
      nextStep: isComplete ? 'finalize' : 'continue'
    });
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Chunk upload error:`, error);
    res.status(500).json({ message: 'Error processing chunk', error: error.message });
  }
});

// Video upload finalization route
router.post('/finalize-video-upload', async (req, res) => {
  const { uploadId } = req.body;
  
  if (!uploadId) {
    return res.status(400).json({ message: 'Missing uploadId' });
  }

  const upload = uploadChunks.get(uploadId);
  if (!upload) {
    return res.status(404).json({ message: 'Upload not found' });
  }

  if (upload.chunks.some(chunk => chunk === undefined)) {
    return res.status(400).json({ message: 'Not all chunks received' });
  }

  const uploadStartTime = Date.now();
  let tempPath: string | null = null;
  
  console.log(`[${new Date().toISOString()}] Starting video upload for ID ${upload.selectedNameId}`);

  try {
    // Combine chunks into a single buffer
    const completeBuffer = Buffer.concat(upload.chunks);
    
    // Write to temporary file
    tempPath = path.join(uploadsDir, `${uploadId}_${upload.fileName}`);
    fs.writeFileSync(tempPath, completeBuffer);

    // Upload directly to MinIO
    const objectName = `video/${upload.selectedNameId}/${upload.fileName}`;
    console.log(`[${new Date().toISOString()}] Uploading video to MinIO: ${objectName}`);
    
    await uploadFile(tempPath, objectName, 'video/webm');
    
    // Update database
    const markResult = await markNameAsRecorded(upload.selectedNameId);
    const pathUpdateResult = await updateProcessedVideoPath(upload.selectedNameId, objectName);
    
    // Clean up
    if (tempPath) {
      safeUnlink(tempPath);
    }
    uploadChunks.delete(uploadId);
    
    const totalDuration = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] Upload completed in ${totalDuration}s`);

    res.status(200).json({
      message: 'Video uploaded successfully',
      duration: totalDuration,
      objectName
    });
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Error uploading video:`, error);
    await markNameAsUnrecorded(upload.selectedNameId);
    
    // Cleanup on error
    try {
      if (tempPath && fs.existsSync(tempPath)) {
        safeUnlink(tempPath);
      }
      uploadChunks.delete(uploadId);
    } catch (cleanupError) {
      console.error(`[${new Date().toISOString()}] Error during cleanup:`, cleanupError);
    }

    res.status(500).json({
      message: 'Error uploading video',
      error: error.message
    });
  }
});

// Get pre-signed URL for direct upload
router.post('/get-upload-url', async (req, res) => {
  try {
    const { fileName, contentType, selectedNameId } = req.body;
    
    if (!fileName || !contentType || !selectedNameId) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    // Generate a unique object name for the video
    const timestamp = Date.now();
    const uniqueId = uuidv4();
    const objectName = `video/${selectedNameId}/${timestamp}_${uniqueId}_${fileName}`;

    // Get pre-signed URL
    const uploadUrl = await getPresignedUploadUrl(objectName, contentType);

    res.json({
      uploadUrl,
      objectName,
      expiresIn: 3600 // URL expires in 1 hour
    });
  } catch (error: any) {
    console.error('Error generating upload URL:', error);
    res.status(500).json({ message: 'Error generating upload URL', error: error.message });
  }
});

// Process video uploaded directly to MinIO
router.post('/process-video', async (req, res) => {
  const { objectName, selectedNameId } = req.body;
  
  if (!objectName || !selectedNameId) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const uploadStartTime = Date.now();
  const processId = uuidv4();
  console.log(`[${new Date().toISOString()}] [${processId}] Starting video processing for ID ${selectedNameId}`);

  // Set response timeout
  res.setTimeout(600000, () => {
    console.error(`[${new Date().toISOString()}] [${processId}] Response timeout after 10 minutes`);
    if (!res.headersSent) {
      res.status(504).json({
        message: 'Request timeout',
        error: 'The processing took too long'
      });
    }
  });

  let tempPath: string | null = null;
  let remuxedPath: string | null = null;
  let outputDir: string | null = null;
  let processingStats = {
    downloadStartTime: 0,
    downloadEndTime: 0,
    remuxStartTime: 0,
    remuxEndTime: 0,
    ffmpegStartTime: 0,
    ffmpegEndTime: 0,
    uploadStartTime: 0,
    uploadEndTime: 0,
    totalFrames: 0,
    processedFrames: 0,
    currentFps: 0,
    averageFps: 0,
    lastProgressUpdate: 0,
    segmentCount: 0,
    totalSegmentSize: 0
  };

  try {
    // Download the file from MinIO to process it
    tempPath = path.join(uploadsDir, `temp_${Date.now()}_${uuidv4()}.webm`);
    console.log(`[${new Date().toISOString()}] [${processId}] Downloading file from MinIO to ${tempPath}`);
    
    processingStats.downloadStartTime = Date.now();
    await retryOperation(
      () => minioClient.fGetObject(BUCKET_NAME, objectName, tempPath!),
      3,
      1000,
      'Download from MinIO',
      processId
    );
    processingStats.downloadEndTime = Date.now();
    
    const downloadDuration = ((processingStats.downloadEndTime - processingStats.downloadStartTime) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] [${processId}] Download completed in ${downloadDuration}s`);

    // Remux the WebM file to ensure it's properly finalized
    remuxedPath = path.join(uploadsDir, `remuxed_${Date.now()}_${uuidv4()}.webm`);
    processingStats.remuxStartTime = Date.now();
    await remuxWebM(tempPath, remuxedPath, processId);
    processingStats.remuxEndTime = Date.now();
    
    const remuxDuration = ((processingStats.remuxEndTime - processingStats.remuxStartTime) / 1000).toFixed(1);
    console.log(`[${new Date().toISOString()}] [${processId}] Remux completed in ${remuxDuration}s`);

    const timestamp = Date.now();
    const uniqueId = uuidv4();
    outputDir = path.join(processedDir, `hls_${selectedNameId}_${timestamp}_${uniqueId}`);
    const manifestPath = path.join(outputDir, 'manifest.m3u8');
    
    // Create output directory for HLS segments
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`[${new Date().toISOString()}] [${processId}] Created output directory: ${outputDir}`);

    // Process the video with FFmpeg
    await new Promise<void>((resolve, reject) => {
      let timeoutTriggered = false;
      let lastProgress = 0;
      let lastProgressTime = Date.now();
      let processingStartTime = Date.now();
      
      if (!remuxedPath) {
        reject(new Error('Remuxed file path is null'));
        return;
      }
      
      const ffmpegProcess = ffmpeg(remuxedPath)
        .inputOptions([
          '-err_detect ignore_err',
          '-fflags +genpts',
          '-i_qfactor 0.71',
          '-qcomp 0.6',
          '-qdiff 4',
          '-qblur 0.2',
          '-qmin 10',
          '-qmax 51',
          '-analyzeduration 2147483647',
          '-probesize 2147483647',
          '-vsync 1',
          '-async 1',
          '-loglevel debug'
        ])
        .outputOptions([
          '-c:v libx264',
          '-c:a aac',
          '-b:v 1000k',
          '-b:a 128k',
          '-f hls',
          '-hls_time 10',
          '-hls_list_size 0',
          '-preset ultrafast',
          '-hide_banner',
          '-loglevel debug',
          '-movflags +faststart',
          '-pix_fmt yuv420p',
          '-max_muxing_queue_size 1024',
          '-avoid_negative_ts make_zero',
          '-fflags +genpts+igndts',
          '-use_wallclock_as_timestamps 1',
          '-vsync cfr',
          '-r 30000/1001',
          '-af aresample=async=1:min_hard_comp=0.100000',
          '-ar 48000',
          '-ac 2'
        ])
        .output(manifestPath)
        .on('start', cmd => {
          console.log(`[${new Date().toISOString()}] [${processId}] FFmpeg started with command:`, cmd);
          processingStats.ffmpegStartTime = Date.now();
          processingStartTime = Date.now();
        })
        .on('progress', progress => {
          const now = Date.now();
          processingStats.processedFrames = progress.frames || 0;
          processingStats.currentFps = progress.currentFps || 0;
          
          // Calculate average FPS
          const elapsedSeconds = (now - processingStats.ffmpegStartTime) / 1000;
          processingStats.averageFps = elapsedSeconds > 0 ? processingStats.processedFrames / elapsedSeconds : 0;
          
          // Log progress every 5% or every 10 seconds
          if ((progress.percent && progress.percent - lastProgress >= 5) || 
              (now - lastProgressTime >= 10000)) {
            lastProgress = progress.percent || 0;
            lastProgressTime = now;
            const elapsed = ((now - processingStartTime) / 1000).toFixed(1);
            console.log(`[${new Date().toISOString()}] [${processId}] FFmpeg progress:`, {
              percent: progress.percent?.toFixed(1),
              frames: progress.frames,
              currentFps: progress.currentFps?.toFixed(2),
              averageFps: processingStats.averageFps.toFixed(2),
              targetSize: progress.targetSize,
              timemark: progress.timemark,
              elapsed: `${elapsed}s`,
              currentKbps: progress.currentKbps
            });
          }
        })
        .on('error', (err, stdout, stderr) => {
          console.error(`[${new Date().toISOString()}] [${processId}] FFmpeg error:`, err.message);
          console.error(`[${new Date().toISOString()}] [${processId}] FFmpeg stderr:`, stderr);
          console.error(`[${new Date().toISOString()}] [${processId}] FFmpeg stdout:`, stdout);
          reject(err);
        })
        .on('end', async () => {
          if (timeoutTriggered) return;
          processingStats.ffmpegEndTime = Date.now();
          const processingTime = ((processingStats.ffmpegEndTime - processingStats.ffmpegStartTime) / 1000).toFixed(1);
          console.log(`[${new Date().toISOString()}] [${processId}] FFmpeg processing finished in ${processingTime}s`);
          
          try {
            // Upload manifest and segments to MinIO
            const manifestObjectName = `video/${selectedNameId}/manifest.m3u8`;
            console.log(`[${new Date().toISOString()}] [${processId}] Uploading manifest to MinIO: ${manifestObjectName}`);
            
            processingStats.uploadStartTime = Date.now();
            await retryOperation(
              () => uploadHLSManifest(manifestPath, manifestObjectName, 'application/vnd.apple.mpegurl'),
              3,
              1000,
              'Upload manifest',
              processId
            );

            if (!outputDir) {
              throw new Error('Output directory is null');
            }

            const segments = fs.readdirSync(outputDir).filter(file => file.endsWith('.ts'));
            processingStats.segmentCount = segments.length;
            console.log(`[${new Date().toISOString()}] [${processId}] Uploading ${segments.length} segments to MinIO`);
            
            const limit = pLimit(5);
            const uploadPromises = segments.map(segment => limit(async () => {
              const segmentPath = path.join(outputDir!, segment);
              const segmentObjectName = `video/${selectedNameId}/${segment}`;
              const stats = fs.statSync(segmentPath);
              processingStats.totalSegmentSize += stats.size;
              
              await retryOperation(
                () => uploadHLSSegment(segmentPath, segmentObjectName, 'video/MP2T'),
                3,
                1000,
                `Upload segment ${segment}`,
                processId
              );
            }));

            await Promise.all(uploadPromises);
            processingStats.uploadEndTime = Date.now();
            
            const uploadDuration = ((processingStats.uploadEndTime - processingStats.uploadStartTime) / 1000).toFixed(1);
            const totalSegmentSizeMB = (processingStats.totalSegmentSize / (1024 * 1024)).toFixed(2);
            console.log(`[${new Date().toISOString()}] [${processId}] Upload completed in ${uploadDuration}s`, {
              segmentCount: processingStats.segmentCount,
              totalSize: `${totalSegmentSizeMB}MB`,
              averageSegmentSize: `${(processingStats.totalSegmentSize / processingStats.segmentCount / 1024).toFixed(2)}KB`
            });
            
            const markResult = await retryOperation(
              () => markNameAsRecorded(selectedNameId),
              3,
              1000,
              'Mark name as recorded',
              processId
            );
            
            const pathUpdateResult = await retryOperation(
              () => updateProcessedVideoPath(selectedNameId, manifestObjectName),
              3,
              1000,
              'Update processed video path',
              processId
            );
            
            // Clean up
            if (outputDir) {
              fs.rmSync(outputDir, { recursive: true, force: true });
              console.log(`[${new Date().toISOString()}] [${processId}] Cleaned up output directory: ${outputDir}`);
            }
            if (tempPath) {
              safeUnlink(tempPath);
              console.log(`[${new Date().toISOString()}] [${processId}] Cleaned up temporary file: ${tempPath}`);
            }
            if (remuxedPath) {
              safeUnlink(remuxedPath);
              console.log(`[${new Date().toISOString()}] [${processId}] Cleaned up remuxed file: ${remuxedPath}`);
            }
            
            const totalDuration = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
            console.log(`[${new Date().toISOString()}] [${processId}] Processing completed in ${totalDuration}s`, {
              downloadTime: `${((processingStats.downloadEndTime - processingStats.downloadStartTime) / 1000).toFixed(1)}s`,
              remuxTime: `${((processingStats.remuxEndTime - processingStats.remuxStartTime) / 1000).toFixed(1)}s`,
              processingTime: `${((processingStats.ffmpegEndTime - processingStats.ffmpegStartTime) / 1000).toFixed(1)}s`,
              uploadTime: `${((processingStats.uploadEndTime - processingStats.uploadStartTime) / 1000).toFixed(1)}s`,
              totalFrames: processingStats.processedFrames,
              averageFps: processingStats.averageFps.toFixed(2),
              segmentCount: processingStats.segmentCount,
              totalSize: `${totalSegmentSizeMB}MB`
            });
            
            resolve();
          } catch (error: any) {
            console.error(`[${new Date().toISOString()}] [${processId}] Error during MinIO upload or DB update:`, error);
            await markNameAsUnrecorded(selectedNameId);
            reject(error);
          }
        });

      // Set a timeout for FFmpeg processing
      setTimeout(() => {
        timeoutTriggered = true;
        if (ffmpegProcess) {
          console.error(`[${new Date().toISOString()}] [${processId}] FFmpeg processing timed out after 5 minutes`);
          ffmpegProcess.kill('SIGKILL');
          reject(new Error('FFmpeg processing timed out'));
        }
      }, 300000);
    });

    res.status(200).json({
      message: 'Video processed successfully',
      duration: ((Date.now() - uploadStartTime) / 1000).toFixed(1),
      stats: {
        downloadTime: `${((processingStats.downloadEndTime - processingStats.downloadStartTime) / 1000).toFixed(1)}s`,
        remuxTime: `${((processingStats.remuxEndTime - processingStats.remuxStartTime) / 1000).toFixed(1)}s`,
        processingTime: `${((processingStats.ffmpegEndTime - processingStats.ffmpegStartTime) / 1000).toFixed(1)}s`,
        uploadTime: `${((processingStats.uploadEndTime - processingStats.uploadStartTime) / 1000).toFixed(1)}s`,
        totalFrames: processingStats.processedFrames,
        averageFps: processingStats.averageFps.toFixed(2),
        segmentCount: processingStats.segmentCount,
        totalSize: `${(processingStats.totalSegmentSize / (1024 * 1024)).toFixed(2)}MB`
      }
    });
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] [${processId}] Error processing video:`, error);
    await markNameAsUnrecorded(selectedNameId);
    
    // Cleanup on error
    try {
      if (outputDir && fs.existsSync(outputDir)) {
        fs.rmSync(outputDir, { recursive: true, force: true });
        console.log(`[${new Date().toISOString()}] [${processId}] Cleaned up output directory after error: ${outputDir}`);
      }
      if (tempPath && fs.existsSync(tempPath)) {
        safeUnlink(tempPath);
        console.log(`[${new Date().toISOString()}] [${processId}] Cleaned up temporary file after error: ${tempPath}`);
      }
      if (remuxedPath && fs.existsSync(remuxedPath)) {
        safeUnlink(remuxedPath);
        console.log(`[${new Date().toISOString()}] [${processId}] Cleaned up remuxed file after error: ${remuxedPath}`);
      }
      // Delete the original file from MinIO if processing failed
      await retryOperation(
        () => minioClient.removeObject(BUCKET_NAME, objectName),
        3,
        1000,
        'Delete original file from MinIO',
        processId
      );
      console.log(`[${new Date().toISOString()}] [${processId}] Deleted original file from MinIO after error: ${objectName}`);
    } catch (cleanupError) {
      console.error(`[${new Date().toISOString()}] [${processId}] Error during cleanup:`, cleanupError);
    }

    res.status(500).json({
      message: 'Error processing video',
      error: error.message,
      stats: {
        downloadTime: `${((processingStats.downloadEndTime - processingStats.downloadStartTime) / 1000).toFixed(1)}s`,
        remuxTime: `${((processingStats.remuxEndTime - processingStats.remuxStartTime) / 1000).toFixed(1)}s`,
        processingTime: `${((processingStats.ffmpegEndTime - processingStats.ffmpegStartTime) / 1000).toFixed(1)}s`,
        uploadTime: `${((processingStats.uploadEndTime - processingStats.uploadStartTime) / 1000).toFixed(1)}s`,
        totalFrames: processingStats.processedFrames,
        averageFps: processingStats.averageFps.toFixed(2),
        segmentCount: processingStats.segmentCount,
        totalSize: `${(processingStats.totalSegmentSize / (1024 * 1024)).toFixed(2)}MB`
      }
    });
  }
});

export default router; 