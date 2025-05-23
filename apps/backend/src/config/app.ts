import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Determine base directory assuming src is one level down from app root
const baseDir = path.resolve(__dirname, '../..'); 
const uploadsDir = path.join(baseDir, 'uploads');
const processedDir = path.join(baseDir, 'processed');

// Ensure directories exist
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(processedDir, { recursive: true });

// Configure multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`)
});

// Configure multer instances
export const upload = multer({ storage });

export const videoUpload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      cb(null, `${timestamp}-${file.originalname}`);
    }
  }),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit
  }
});

export const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1024 * 1024, // 1MB limit per chunk
    files: 1 // Only allow one file per request
  }
});

// Configure rate limiting
export const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 uploads per window
  message: 'Too many uploads from this IP, please try again later.'
});

// Create Express app
const app = express();

// Configure Express for streaming uploads with increased limits
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: true }));

export { app, uploadsDir, processedDir }; 