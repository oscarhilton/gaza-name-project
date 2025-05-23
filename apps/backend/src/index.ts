import express, { Request, Response } from 'express';
import http from 'http';
import WebSocket from 'ws';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import pLimit from 'p-limit';
import {
  connectToDB,
  createMartyrsTable,
  insertMartyrs,
  getUnrecordedNames,
  markNameAsRecorded,
  markNameAsUnrecorded,
  updateProcessedAudioPath,
  updateProcessedVideoPath,
  getRecordedAudioPaths,
  getRecordedVideoPaths,
  getPaginatedRecordedSegments,
  checkAndCleanupMissingAudioFiles,
  updateExistingRecordsWithPhonetics,
  initializeDatabase
} from './db';
import {
  initializeMinio,
  uploadFile,
  getFileUrl,
  uploadHLSManifest,
  uploadHLSSegment
} from './minio';
import cors from 'cors';
import apiRoutes from './routes/apiRoutes';
import uploadRoutes from './routes/uploadRoutes';
import { cleanupOldTempDirs } from './utils/cleanup';

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process, just log the error
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit the process, just log the error
});

// Add request logging middleware
const requestLogger = (req: Request, res: Response, next: Function) => {
  const start = Date.now();
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
  });
  
  next();
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Use request logging middleware
app.use(requestLogger);

// Configure Express for streaming uploads with increased limits
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

// Increase timeout for the HTTP server
server.timeout = 600000; // 10 minutes
server.keepAliveTimeout = 600000; // 10 minutes
server.headersTimeout = 600000; // 10 minutes

// Determine base directory assuming src is one level down from app root
const baseDir = path.resolve(__dirname, '..'); 
const uploadsDir = path.join(baseDir, 'uploads');
const processedDir = path.join(baseDir, 'processed');
const processedFilesDir = path.join(processedDir, 'processed');

// Ensure directories exist
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(processedDir, { recursive: true });
fs.mkdirSync(processedFilesDir, { recursive: true });

// Configure multer for chunk uploads
const chunkStorage = multer.memoryStorage();
const chunkUpload = multer({
  storage: chunkStorage,
  limits: {
    fileSize: 1024 * 1024, // 1MB per chunk
    files: 1
  }
});

// Configure multer for complete file uploads
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(processedDir, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB max file size
    files: 1
  }
});

// Configure rate limiting
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many upload requests from this IP, please try again later.'
});

// Add error handling for multer
const handleMulterError = (err: any, req: Request, res: Response, next: Function) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'File too large',
        message: 'The uploaded file exceeds the size limit of 1MB per chunk'
      });
    }
    return res.status(400).json({
      error: 'Upload error',
      message: err.message
    });
  }
  next(err);
};

// Apply multer error handling middleware
app.use(handleMulterError);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req: Request, res: Response) => res.send('Hello from backend!'));

app.post('/api/upload-audio', upload.single('audio'), async (req: Request, res: Response) => {
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

// Store for temporary upload chunks with metadata
const uploadChunks = new Map<string, { 
  chunks: Buffer[], 
  totalChunks: number,
  lastActivity: number,
  selectedNameId: number,
  fileName: string,
  startTime: number
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

// Store active FFmpeg processes
const activeFFmpegProcesses = new Map<string, { process: any, ws: WebSocket | null }>();

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected via WebSocket');
  
  ws.on('message', (msg: string) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.type === 'subscribe_ffmpeg') {
        const { uploadId } = data;
        if (activeFFmpegProcesses.has(uploadId)) {
          const process = activeFFmpegProcesses.get(uploadId);
          if (process) {
            process.ws = ws;
          }
        }
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  });

  ws.on('close', () => {
    // Clean up any processes this client was subscribed to
    for (const [uploadId, process] of activeFFmpegProcesses.entries()) {
      if (process.ws === ws) {
        process.ws = null;
      }
    }
  });
});

app.post('/api/upload-video', uploadLimiter, upload.single('video'), async (req: Request, res: Response) => {
  const uploadStartTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting video upload process`);
  
  // Set response timeout
  res.setTimeout(600000, () => {
    console.error(`[${new Date().toISOString()}] Response timeout after 10 minutes`);
    if (!res.headersSent) {
      res.status(504).json({
        message: 'Request timeout',
        error: 'The upload took too long to process'
      });
    }
  });

  if (!req.file) {
    console.log(`[${new Date().toISOString()}] No video file uploaded`);
    return res.status(400).send('No video file uploaded.');
  }
  
  const selectedNameIdString = req.body.selectedNameId;
  if (!selectedNameIdString) {
    console.log(`[${new Date().toISOString()}] No name ID selected`);
    safeUnlink(req.file.path);
    return res.status(400).send('No name ID selected.');
  }
  
  const selectedNameId = parseInt(selectedNameIdString);
  if (isNaN(selectedNameId)) {
    console.log(`[${new Date().toISOString()}] Invalid name ID: ${selectedNameIdString}`);
    safeUnlink(req.file.path);
    return res.status(400).send('Invalid Name ID.');
  }

  const inputPath = req.file.path;
  const timestamp = Date.now();
  const uniqueId = uuidv4();
  const manifestObjectName = `video/${selectedNameId}/manifest.m3u8`;
  const tempDir = path.join(processedDir, `temp_${timestamp}_${uniqueId}`);
  const manifestPath = path.join(tempDir, 'manifest.m3u8');
  
  console.log(`[${new Date().toISOString()}] Processing video upload: ${req.file.originalname} for ID ${selectedNameId}`);
  console.log(`[${new Date().toISOString()}] File size: ${(req.file.size / (1024 * 1024)).toFixed(2)}MB`);
  console.log(`[${new Date().toISOString()}] Input path: ${inputPath}`);
  console.log(`[${new Date().toISOString()}] Temp directory: ${tempDir}`);

  // Create temporary directory for HLS segments
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    console.log(`[${new Date().toISOString()}] Instantiating FFmpeg process`);
    
    const result = await new Promise<any>((resolve, reject) => {
      let timeoutTriggered = false;
      let lastProgress = 0;
      let ffmpegStarted = false;
      let ffmpegEnded = false;
      let ffmpegErrored = false;
      
      // Validate input file before starting FFmpeg
      try {
        const inputStats = fs.statSync(inputPath);
        console.log(`[${new Date().toISOString()}] [FFmpeg] Input file validation:`, {
          exists: true,
          size: inputStats.size,
          permissions: inputStats.mode,
          isFile: inputStats.isFile(),
          isDirectory: inputStats.isDirectory()
        });

        // Try to probe the input file first
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
          if (err) {
            console.error(`[${new Date().toISOString()}] [FFmpeg] Input file probe failed:`, err);
            reject(new Error('Input file probe failed'));
            return;
          }
          console.log(`[${new Date().toISOString()}] [FFmpeg] Input file probe successful:`, {
            format: metadata.format,
            streams: metadata.streams
          });
        });
      } catch (err) {
        console.error(`[${new Date().toISOString()}] [FFmpeg] Input file validation failed:`, err);
        reject(new Error('Input file validation failed'));
        return;
      }

      // Validate output directory
      try {
        const outputDir = path.dirname(manifestPath);
        fs.mkdirSync(outputDir, { recursive: true });
        const outputStats = fs.statSync(outputDir);
        console.log(`[${new Date().toISOString()}] [FFmpeg] Output directory validation:`, {
          exists: true,
          permissions: outputStats.mode,
          isDirectory: outputStats.isDirectory(),
          path: outputDir
        });
      } catch (err) {
        console.error(`[${new Date().toISOString()}] [FFmpeg] Output directory validation failed:`, err);
        reject(new Error('Output directory validation failed'));
        return;
      }
      
      const ffmpegProcess = ffmpeg(inputPath)
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
          console.log(`[${new Date().toISOString()}] FFmpeg started with command:`, cmd);
          ffmpegStarted = true;
        })
        .on('progress', progress => {
          console.log(`[${new Date().toISOString()}] FFmpeg progress:`, {
            percent: progress.percent?.toFixed(1),
            frames: progress.frames,
            currentFps: progress.currentFps,
            targetSize: progress.targetSize,
            timemark: progress.timemark,
            currentKbps: progress.currentKbps
          });
        })
        .on('error', (err, stdout, stderr) => {
          console.error(`[${new Date().toISOString()}] FFmpeg error:`, err.message);
          console.error(`[${new Date().toISOString()}] FFmpeg stderr:`, stderr);
          console.error(`[${new Date().toISOString()}] FFmpeg stdout:`, stdout);
          ffmpegErrored = true;
          reject(err);
        })
        .on('end', async () => {
          ffmpegEnded = true;
          console.log(`[${new Date().toISOString()}] [FFmpeg] Processing finished for: ${manifestPath}`);
          console.log(`[${new Date().toISOString()}] [FFmpeg] Process state:`, {
            started: ffmpegStarted,
            ended: ffmpegEnded,
            errored: ffmpegErrored,
            timeoutTriggered
          });
          
          // Verify the output files
          try {
            const outputFiles = fs.readdirSync(path.dirname(manifestPath));
            console.log(`[${new Date().toISOString()}] [FFmpeg] Output files:`, outputFiles);
            
            if (!fs.existsSync(manifestPath)) {
              console.error(`[${new Date().toISOString()}] Processed manifest not found: ${manifestPath}`);
              await markNameAsUnrecorded(selectedNameId);
              reject(new Error('Processed manifest was not created successfully'));
              return;
            }

            // Verify the manifest file
            const manifestContent = fs.readFileSync(manifestPath, 'utf8');
            console.log(`[${new Date().toISOString()}] [FFmpeg] Manifest content:`, manifestContent);
            
            // Upload manifest to MinIO
            console.log(`[${new Date().toISOString()}] Uploading manifest to MinIO: ${manifestObjectName}`);
            await uploadHLSManifest(manifestPath, manifestObjectName, 'application/vnd.apple.mpegurl');
            console.log(`[${new Date().toISOString()}] Manifest uploaded successfully: ${manifestObjectName}`);
            
            // Upload segments in parallel with concurrency limit
            const segments = fs.readdirSync(tempDir).filter(file => file.endsWith('.ts'));
            console.log(`[${new Date().toISOString()}] Found ${segments.length} segments to upload`);
            
            const limit = pLimit(5);
            const uploadPromises = segments.map(segment => limit(async () => {
              const segmentPath = path.join(tempDir, segment);
              const segmentObjectName = `video/${selectedNameId}/${segment}`;
              try {
                console.log(`[${new Date().toISOString()}] Uploading segment: ${segment}`);
                await uploadHLSSegment(segmentPath, segmentObjectName, 'video/MP2T');
                console.log(`[${new Date().toISOString()}] Segment ${segment} uploaded successfully`);
              } catch (minioError) {
                console.error(`[${new Date().toISOString()}] MinIO segment upload error for ${segment}:`, minioError);
                throw minioError;
              }
            }));

            const results = await Promise.allSettled(uploadPromises);
            const failedUploads = results.filter(r => r.status === 'rejected');
            if (failedUploads.length > 0) {
              throw new Error(`${failedUploads.length} segment uploads failed`);
            }

            const markResult = await markNameAsRecorded(selectedNameId);
            const pathUpdateResult = await updateProcessedVideoPath(selectedNameId, manifestObjectName);

            // Clean up temporary files
            fs.rmSync(tempDir, { recursive: true, force: true });
            safeUnlink(inputPath);

            const totalDuration = ((Date.now() - uploadStartTime) / 1000).toFixed(1);
            console.log(`[${new Date().toISOString()}] Upload completed in ${totalDuration}s for ID ${selectedNameId}`);

            resolve({ 
              message: 'Video processed & stored in MinIO.', 
              processedFile: manifestObjectName,
              dbMarkUpdate: markResult,
              dbPathUpdate: pathUpdateResult,
              duration: totalDuration
            });
          } catch (error: any) {
            console.error(`[${new Date().toISOString()}] Error during MinIO upload or DB update:`, error);
            await markNameAsUnrecorded(selectedNameId);
            reject(error);
          }
        });

      // Set a timeout for FFmpeg processing
      setTimeout(() => {
        timeoutTriggered = true;
        if (ffmpegProcess) {
          console.error(`[${new Date().toISOString()}] FFmpeg processing timed out after 5 minutes`);
          ffmpegProcess.kill('SIGKILL');
          reject(new Error('FFmpeg processing timed out'));
        }
      }, 300000); // 5 minutes
    });
    console.log(`[${new Date().toISOString()}] FFmpeg promise resolved`);
    if (!res.headersSent) {
      res.status(200).json(result);
    }
  } catch (error: any) {
    console.error(`[${new Date().toISOString()}] Overall processing error:`, error.message);
    safeUnlink(inputPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
    await markNameAsUnrecorded(selectedNameId);
    if (!res.headersSent) {
      res.status(500).json({ 
        message: 'Video processing or upload failed.', 
        error: error.message 
      });
    }
  }
});

app.post('/api/upload-video-chunk', uploadLimiter, chunkUpload.single('chunk'), async (req, res) => {
  try {
    console.log('Received chunk upload request:', {
      uploadId: req.body.uploadId,
      chunkIndex: req.body.chunkIndex,
      totalChunks: req.body.totalChunks,
      fileName: req.body.fileName,
      chunkSize: req.file?.size
    });

    if (!req.file) {
      console.error('No file received in chunk upload');
      return res.status(400).json({ error: 'No file received' });
    }

    const { uploadId, chunkIndex, totalChunks, fileName } = req.body;
    if (!uploadId || !chunkIndex || !totalChunks || !fileName) {
      console.error('Missing required fields:', { uploadId, chunkIndex, totalChunks, fileName });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Initialize or get upload tracking
    if (!uploadChunks.has(uploadId)) {
      console.log('Initializing new upload tracking:', uploadId);
      uploadChunks.set(uploadId, {
        chunks: new Array(parseInt(totalChunks)).fill(null),
        totalChunks: parseInt(totalChunks),
        lastActivity: Date.now(),
        selectedNameId: parseInt(req.body.selectedNameId || '0'),
        fileName,
        startTime: Date.now()
      });
    }

    const upload = uploadChunks.get(uploadId);
    if (!upload) {
      console.error('Upload tracking not found:', uploadId);
      return res.status(400).json({ error: 'Upload session not found' });
    }

    // Store chunk
    upload.chunks[parseInt(chunkIndex)] = req.file.buffer;
    console.log(`Stored chunk ${chunkIndex} for upload ${uploadId}`);

    // Check if all chunks received
    const allChunksReceived = upload.chunks.every(chunk => chunk !== null);
    if (allChunksReceived) {
      console.log('All chunks received for upload:', uploadId);
      res.json({ 
        message: 'All chunks received',
        uploadId,
        nextStep: 'finalize'
      });
    } else {
      console.log(`Chunk ${chunkIndex} stored, waiting for more chunks`);
      res.json({ 
        message: 'Chunk received',
        uploadId,
        chunksReceived: upload.chunks.filter(Boolean).length,
        totalChunks: parseInt(totalChunks)
      });
    }
  } catch (error: any) {
    console.error('Error processing chunk:', error);
    res.status(500).json({ 
      error: 'Error processing chunk',
      message: error.message
    });
  }
});

app.post('/api/finalize-video-upload', uploadLimiter, async (req, res) => {
  const { uploadId } = req.body;
  if (!uploadId) {
    return res.status(400).json({ error: 'Missing uploadId' });
  }

  console.log(`[${new Date().toISOString()}] Finalizing upload: ${uploadId}`);
  const upload = uploadChunks.get(uploadId);
  if (!upload) {
    console.error(`[${new Date().toISOString()}] Upload not found: ${uploadId}`);
    return res.status(404).json({ error: 'Upload not found' });
  }

  const uploadStartTime = Date.now();
  let tempPath: string | null = null;

  try {
    // Combine chunks
    console.log(`[${new Date().toISOString()}] Combining chunks for upload: ${uploadId}`);
    const completeFile = Buffer.concat(upload.chunks.filter(Boolean));
    console.log(`[${new Date().toISOString()}] Combined file size: ${completeFile.length} bytes`);

    // Save complete file
    tempPath = path.join(uploadsDir, `${uploadId}_${upload.fileName}`);
    console.log(`[${new Date().toISOString()}] Saving complete file to: ${tempPath}`);
    fs.writeFileSync(tempPath, completeFile);
    console.log(`[${new Date().toISOString()}] Complete file saved successfully`);

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

app.get('/api/fetch-and-store-martyrs', async (req: Request, res: Response) => {
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

app.get('/api/get-unrecorded-names', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 200; // Increased default limit
    const names = await getUnrecordedNames(limit);
    res.status(200).json(names);
  } catch (error: any) {
    console.error('Error fetching unrecorded names:', error);
    res.status(500).send(`Error fetching names: ${error.message}`);
  }
});

app.get('/api/generate-master-loop', async (req: Request, res: Response) => {
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
    const fileListPath = path.join(uploadsDir, `concat_list_${Date.now()}.txt`);
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

app.get('/api/audio/:filename', async (req: Request, res: Response) => {
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

app.get('/api/video/:filename', async (req: Request, res: Response) => {
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

app.get('/api/recorded-segments', async (req: Request, res: Response) => {
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

app.get('/api/cleanup-missing-files', async (req: Request, res: Response) => {
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

app.post('/api/update-phonetics', async (req: Request, res: Response) => {
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

setInterval(async () => {
  try {
    const result = await checkAndCleanupMissingAudioFiles(processedDir);
    if (result.success) {
      console.log(`Periodic cleanup: Checked ${result.checkedCount} files, found ${result.missingFilesCount} missing files`);
    } else {
      console.error('Periodic cleanup failed:', result.error);
    }
  } catch (error) {
    console.error('Periodic cleanup error:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Safe file deletion wrapper
const safeUnlink = (filePath: string) => {
  fs.unlink(filePath, err => {
    if (err && err.code !== 'ENOENT') {
      console.error(`[${new Date().toISOString()}] File deletion error for ${filePath}:`, err);
    }
  });
};

const startServer = async () => {
  try {
    // Initialize database with schema
    console.log('Initializing database...');
    await initializeDatabase();
    
    // Initialize MinIO
    console.log('Initializing MinIO...');
    await initializeMinio();
    
    // Initialize cleanup
    cleanupOldTempDirs().catch(err => {
      console.error('Error during initial cleanup:', err);
    });
    
    // Start the server
    const port = process.env.PORT || 3001;
    server.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    // Give some time for logs to be written before exiting
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
};

// Handle process termination
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Use the upload routes
app.use('/api', uploadRoutes);

startServer(); 