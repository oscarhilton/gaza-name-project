import { Client } from 'minio';
import fs from 'fs';

const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT || 'minio',
  port: parseInt(process.env.MINIO_PORT || '9000'),
  useSSL: process.env.MINIO_USE_SSL === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin'
});

const BUCKET_NAME = 'gaza-name-project';

export const initializeMinio = async () => {
  console.log(`[${new Date().toISOString()}] Initializing MinIO client with config:`, {
    endPoint: process.env.MINIO_ENDPOINT || 'minio',
    port: parseInt(process.env.MINIO_PORT || '9000'),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY
  });

  try {
    const bucketExists = await minioClient.bucketExists(BUCKET_NAME);
    console.log(`[${new Date().toISOString()}] MinIO bucket ${BUCKET_NAME} exists:`, bucketExists);
    
    if (!bucketExists) {
      console.log(`[${new Date().toISOString()}] Creating MinIO bucket: ${BUCKET_NAME}`);
      await minioClient.makeBucket(BUCKET_NAME);
      console.log(`[${new Date().toISOString()}] MinIO bucket created successfully`);

      // Set bucket policy to allow public read access for video files
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${BUCKET_NAME}/video/*`]
          }
        ]
      };

      await minioClient.setBucketPolicy(BUCKET_NAME, JSON.stringify(policy));
      console.log(`[${new Date().toISOString()}] Set bucket policy for public read access to video files`);
    }

  } catch (error) {
    console.error(`[${new Date().toISOString()}] MinIO initialization error:`, error);
    throw error;
  }
};

export const uploadFile = async (filePath: string, objectName: string, contentType: string): Promise<string> => {
  console.log(`[${new Date().toISOString()}] Starting MinIO upload:`, {
    filePath,
    objectName,
    contentType
  });

  try {
    const stats = fs.statSync(filePath);
    console.log(`[${new Date().toISOString()}] File stats:`, {
      size: stats.size,
      permissions: stats.mode,
      isFile: stats.isFile()
    });

    await minioClient.fPutObject(BUCKET_NAME, objectName, filePath, {
      'Content-Type': contentType
    });
    console.log(`[${new Date().toISOString()}] MinIO upload successful: ${objectName}`);
    return objectName;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] MinIO upload error:`, error);
    throw error;
  }
};

export const getFileUrl = async (objectName: string, expirySeconds = 3600): Promise<string> => {
  try {
    return await minioClient.presignedGetObject(BUCKET_NAME, objectName, expirySeconds);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error getting presigned URL:`, err);
    throw err;
  }
};

export const uploadHLSManifest = async (filePath: string, objectName: string, contentType: string): Promise<string> => {
  console.log(`[${new Date().toISOString()}] Starting HLS manifest upload:`, {
    filePath,
    objectName,
    contentType
  });

  try {
    await minioClient.fPutObject(BUCKET_NAME, objectName, filePath, {
      'Content-Type': contentType
    });
    console.log(`[${new Date().toISOString()}] HLS manifest upload successful: ${objectName}`);
    return objectName;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] HLS manifest upload error:`, error);
    throw error;
  }
};

export const uploadHLSSegment = async (filePath: string, objectName: string, contentType: string): Promise<string> => {
  console.log(`[${new Date().toISOString()}] Starting HLS segment upload:`, {
    filePath,
    objectName,
    contentType
  });

  try {
    await minioClient.fPutObject(BUCKET_NAME, objectName, filePath, {
      'Content-Type': contentType
    });
    console.log(`[${new Date().toISOString()}] HLS segment upload successful: ${objectName}`);
    return objectName;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] HLS segment upload error:`, error);
    throw error;
  }
};

export const deleteFile = async (objectName: string): Promise<void> => {
  try {
    await minioClient.removeObject(BUCKET_NAME, objectName);
  } catch (err) {
    console.error('Error deleting file from MinIO:', err);
    throw err;
  }
};

export const getPresignedUploadUrl = async (objectName: string, contentType: string): Promise<string> => {
  try {
    return await minioClient.presignedPutObject(BUCKET_NAME, objectName, 3600);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error getting presigned upload URL:`, err);
    throw err;
  }
};

export const getPresignedDownloadUrl = async (objectName: string, expiresInSeconds = 3600): Promise<string> => {
  try {
    const url = await minioClient.presignedGetObject(BUCKET_NAME, objectName, expiresInSeconds);
    return url;
  } catch (err) {
    console.error('Error generating pre-signed download URL:', err);
    throw err;
  }
};

export default minioClient; 