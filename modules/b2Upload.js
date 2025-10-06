// modules/b2Upload.js - B2 Upload Module for base44.com integration
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

// Configure S3 client for Backblaze B2
const s3Client = new S3Client({
  region: process.env.B2_REGION || 'us-east-005',
  endpoint: process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.B2_ACCESS_KEY || '005b37c1a06d8720000000003',
    secretAccessKey: process.env.B2_SECRET_KEY || 'K005bgQ4iRKPrjaqphNadA7p5fulKnQ',
  },
});

const BUCKET_NAME = process.env.B2_BUCKET || 'ISTARTX';

// Configure multer for temporary file storage
const upload = multer({ 
  dest: path.join(__dirname, '../tmp/uploads/'),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 20 // Max 20 files
  }
});

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../tmp/uploads/');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/**
 * Upload files to B2 storage with parallel processing
 * @param {string} userId - User ID for folder organization
 * @param {Array} files - Array of file objects from multer
 * @returns {Promise<Array>} - Array of upload results
 */
async function uploadFilesToB2(userId, files) {
  const results = [];
  const errors = [];
  
  // Process files in parallel for better performance
  const uploadPromises = files.map(async (file) => {
    try {
      // Parse filename components
      const originalFilename = file.originalname;
      const fileInfo = path.parse(originalFilename);
      const basename = fileInfo.name;
      const extension = fileInfo.ext;
      
      let b2Filename = originalFilename;
      let suffix = 1;
      
      // Check if file exists and add suffix if needed
      while (true) {
        const b2Key = `${userId}/${b2Filename}`;
        
        try {
          await s3Client.send(new HeadObjectCommand({
            Bucket: BUCKET_NAME,
            Key: b2Key,
          }));
          
          // File exists, add suffix
          b2Filename = `${basename}_${suffix}${extension}`;
          suffix++;
        } catch (error) {
          // File doesn't exist, we can use this filename
          if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
            break;
          }
          break;
        }
      }

      // Read file data asynchronously
      const fileData = await fs.promises.readFile(file.path);
      const finalKey = `${userId}/${b2Filename}`;

      // Upload to B2
      const uploadCommand = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: finalKey,
        Body: fileData,
        ContentType: file.mimetype || 'application/octet-stream',
      });

      await s3Client.send(uploadCommand);

      // Build CDN URL
      const cdnUrl = `${process.env.CDN_BASE_URL || 'https://cdn.istartx.io'}/${finalKey}`;

      return {
        success: true,
        originalFileName: originalFilename,
        finalFileName: b2Filename,
        cdnUrl: cdnUrl,
        b2Key: finalKey,
        fileSize: file.size,
        mimeType: file.mimetype,
        filePath: file.path // For cleanup
      };

    } catch (error) {
      return {
        success: false,
        fileName: file.originalname,
        error: error.message,
        filePath: file.path // For cleanup
      };
    }
  });

  // Wait for all uploads to complete
  const uploadResults = await Promise.all(uploadPromises);
  
  // Separate results and errors
  uploadResults.forEach(result => {
    if (result.success) {
      results.push(result);
    } else {
      errors.push(result);
    }
  });

  // Clean up temp files in parallel
  const cleanupPromises = uploadResults.map(async (result) => {
    try {
      if (result.filePath && await fs.promises.access(result.filePath).then(() => true).catch(() => false)) {
        await fs.promises.unlink(result.filePath);
      }
    } catch (cleanupError) {
      console.error(`Error cleaning up temp file ${result.filePath}:`, cleanupError);
    }
  });
  
  await Promise.all(cleanupPromises);
  
  return { results, errors };
}

module.exports = {
  upload: upload.array('files', 20), // Middleware for handling file uploads
  uploadFilesToB2,
  s3Client,
  BUCKET_NAME
};