import express, { Request, Response } from 'express';
import http from 'http';
import WebSocket from 'ws';
import multer from 'multer';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import {
  connectToDB,
  createMartyrsTable,
  insertMartyrs,
  getUnrecordedNames,
  markNameAsRecorded,
  updateProcessedAudioPath,
  getRecordedAudioPaths,
  getPaginatedRecordedSegments
} from './db';

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Determine base directory assuming src is one level down from app root
const baseDir = path.resolve(__dirname, '..'); 
const uploadsDir = path.join(baseDir, 'uploads');
const processedDir = path.join(baseDir, 'processed');

// Ensure directories exist
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(processedDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`)
});
const upload = multer({ storage });

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
        .audioCodec('pcm_s16le') // Standard WAV codec
        .audioFrequency(22050)   // Common frequency
        .audioChannels(1)        // Mono
        .format('wav')           // Output format
        .on('start', cmd => console.log('FFmpeg started:', cmd))
        .on('error', (err, stdout, stderr) => {
          console.error('FFmpeg error:', err.message);
          console.error('FFmpeg stderr:', stderr);
          reject(err);
        })
        .on('end', async () => {
          console.log('FFmpeg processing finished for:', outputFileName);
          try {
            const markResult = await markNameAsRecorded(selectedNameId);
            const pathUpdateResult = await updateProcessedAudioPath(selectedNameId, outputFileName);
            console.log(`DB update for ID ${selectedNameId}: Mark=${markResult.success}, PathUpdate=${pathUpdateResult.success}`);
            res.status(200).json({ 
              message: 'Audio processed & DB updated.', 
              processedFile: outputFileName,
              dbMarkUpdate: markResult,
              dbPathUpdate: pathUpdateResult
            });
            resolve();
          } catch (dbError: any) {
            console.error('DB error post-processing:', dbError);
            res.status(500).json({ message: 'Audio processed, DB update failed.', dbError: dbError.message });
            reject(dbError);
          }
        })
        .save(outputPath);
    });
  } catch (processingError: any) {
    console.error('Overall processing/DB error:', processingError.message);
    fs.unlink(inputPath, (err) => {if (err) console.error("Error deleting input file on error:", err);}); 
    if (!res.headersSent) {
      res.status(500).send(`Processing error: ${processingError.message}`);
    }
  } finally {
    // Ensure original uploaded file is deleted if it still exists and wasn't moved/renamed by ffmpeg (save() creates new file)
    if (inputPath !== outputPath && fs.existsSync(inputPath)){
        fs.unlink(inputPath, (err) => {if (err) console.error("Error deleting original upload after processing:", err);});
    }
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

app.get('/api/audio/:filename', (req: Request, res: Response) => {
  const { filename } = req.params;
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\') || !/^[a-zA-Z0-9_.-]+$/.test(filename)) {
    return res.status(400).send('Invalid filename.');
  }
  const filePath = path.join(processedDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Audio file not found.');
  
  let contentType = 'application/octet-stream';
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.wav') contentType = 'audio/wav';
  else if (ext === '.mp3') contentType = 'audio/mpeg';
  else if (ext === '.webm') contentType = 'audio/webm';
  // Add more types as needed

  const stat = fs.statSync(filePath);
  res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on('error', (err) => { 
      console.error("Stream error for file:", filename, err);
      if (!res.headersSent) res.status(500).send('Stream error.'); 
      stream.destroy(); 
  });
  req.on('close', () => { 
      console.log("Client closed connection for file:", filename);
      stream.destroy(); 
  });
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

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected via WebSocket');
  ws.on('message', msg => console.log('WS Message:', msg.toString()));
  ws.send('Connected to backend WebSocket.');
  ws.on('close', () => console.log('Client disconnected from WebSocket'));
});

const PORT = process.env.PORT || 3001;
const startServer = async () => {
  try {
    await connectToDB();
    await createMartyrsTable(); // This also ensures processed_audio_path column
    server.listen(PORT, () => console.log(`Backend server listening on port ${PORT}`));
  } catch (error) {
    console.error("Failed to start backend server:", error);
    process.exit(1); // Exit if essential startup fails (like DB connection)
  }
};

startServer(); 