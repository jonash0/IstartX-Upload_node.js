const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, HeadObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand } = require('@aws-sdk/client-s3');

const app = express();

// Set request timeout for large uploads
app.use((req, res, next) => {
  req.setTimeout(10 * 60 * 1000); // 10 minutes timeout
  res.setTimeout(10 * 60 * 1000); // 10 minutes timeout
  next();
});

// Increase payload limits for large uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Configure multer for chunk uploads (10MB chunks)
const chunkUpload = multer({ 
  dest: path.join(__dirname, 'uploads/chunks/'),
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB per chunk (buffer for 10MB + headers)
    fields: 100 // Allow more form fields for metadata
  }
});

// Configure multer for legacy single file uploads (2GB limit)
const upload = multer({ 
  dest: path.join(__dirname, 'uploads/'),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 2GB
    files: 50, // Maximum 50 files at once
    fields: 100 // Allow more form fields
  }
});

// Store for tracking multipart uploads
const activeUploads = new Map();

// Cleanup configuration
const CLEANUP_CONFIG = {
  orphanedChunkCleanupInterval: 60 * 60 * 1000, // 1 hour
  uploadSessionTimeout: 24 * 60 * 60 * 1000, // 24 hours
  maxChunkAge: 2 * 60 * 60 * 1000 // 2 hours for orphaned chunks
};

// Cleanup function for orphaned chunks and expired upload sessions
function cleanupOrphanedChunks() {
  const uploadsDir = path.join(__dirname, 'uploads');
  const chunksDir = path.join(__dirname, 'uploads/chunks');
  const now = Date.now();
  
  console.log('🧹 Starting cleanup of orphaned chunks and expired sessions...');
  
  try {
    // Clean up expired upload sessions
    let expiredSessions = 0;
    for (const [uploadId, uploadInfo] of activeUploads.entries()) {
      if (now - uploadInfo.createdAt > CLEANUP_CONFIG.uploadSessionTimeout) {
        console.log(`🗑️ Removing expired upload session: ${uploadId}`);
        
        // Clean up chunks for this session
        for (const [chunkIndex, chunkInfo] of uploadInfo.chunks.entries()) {
          try {
            if (fs.existsSync(chunkInfo.path)) {
              fs.unlinkSync(chunkInfo.path);
              console.log(`   ├─ Removed chunk ${chunkIndex}: ${chunkInfo.path}`);
            }
          } catch (error) {
            console.error(`   ├─ Error removing chunk ${chunkInfo.path}:`, error.message);
          }
        }
        
        activeUploads.delete(uploadId);
        expiredSessions++;
      }
    }
    
    // Clean up orphaned chunk files (files without active upload sessions)
    let orphanedChunks = 0;
    if (fs.existsSync(chunksDir)) {
      const chunkFiles = fs.readdirSync(chunksDir);
      
      for (const chunkFile of chunkFiles) {
        const chunkPath = path.join(chunksDir, chunkFile);
        
        try {
          const stats = fs.statSync(chunkPath);
          const fileAge = now - stats.mtime.getTime();
          
          if (fileAge > CLEANUP_CONFIG.maxChunkAge) {
            fs.unlinkSync(chunkPath);
            orphanedChunks++;
            console.log(`🗑️ Removed orphaned chunk: ${chunkFile} (age: ${Math.round(fileAge / 1000 / 60)} minutes)`);
          }
        } catch (error) {
          console.error(`Error processing chunk file ${chunkFile}:`, error.message);
        }
      }
    }
    
    // Clean up orphaned temp files in main uploads directory
    let orphanedTempFiles = 0;
    if (fs.existsSync(uploadsDir)) {
      const tempFiles = fs.readdirSync(uploadsDir).filter(file => !file.includes('chunks'));
      
      for (const tempFile of tempFiles) {
        const tempPath = path.join(uploadsDir, tempFile);
        
        try {
          const stats = fs.statSync(tempPath);
          const fileAge = now - stats.mtime.getTime();
          
          if (fileAge > CLEANUP_CONFIG.maxChunkAge) {
            fs.unlinkSync(tempPath);
            orphanedTempFiles++;
            console.log(`🗑️ Removed orphaned temp file: ${tempFile} (age: ${Math.round(fileAge / 1000 / 60)} minutes)`);
          }
        } catch (error) {
          console.error(`Error processing temp file ${tempFile}:`, error.message);
        }
      }
    }
    
    console.log(`✅ Cleanup completed: ${expiredSessions} expired sessions, ${orphanedChunks} orphaned chunks, ${orphanedTempFiles} orphaned temp files removed`);
    
  } catch (error) {
    console.error('❌ Error during cleanup:', error);
  }
}

// Start periodic cleanup
setInterval(cleanupOrphanedChunks, CLEANUP_CONFIG.orphanedChunkCleanupInterval);
console.log(`🧹 Cleanup scheduler started: runs every ${CLEANUP_CONFIG.orphanedChunkCleanupInterval / 1000 / 60} minutes`);

// Add CORS middleware for local testing and production
app.use((req, res, next) => {
  // Set CORS headers
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Content-Length');
  res.header('Access-Control-Max-Age', '86400'); // 24 hours
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    console.log(`🔄 CORS preflight request for ${req.path}`);
    res.status(200).end();
    return;
  }
  
  // Log all requests for debugging
  console.log(`📡 ${req.method} ${req.path} from ${req.get('origin') || 'no-origin'}`);
  next();
});

// Function to generate random filename
function generateRandomFilename(originalFilename) {
  const fileInfo = path.parse(originalFilename);
  const extension = fileInfo.ext;
  const randomString = crypto.randomBytes(16).toString('hex');
  console.log(`Random filename generation: ${originalFilename} → ${randomString}${extension}`);
  return `${randomString}${extension}`;
}

// Function to upload large files using multipart upload
async function uploadLargeFile(fileData, bucketName, key, contentType) {
  const chunkSize = 25 * 1024 * 1024; // 25MB chunks for S3 multipart (large file threshold)
  
  if (fileData.length <= chunkSize) {
    // File is small enough for regular upload
    const uploadCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileData,
      ContentType: contentType,
    });
    return await s3Client.send(uploadCommand);
  }

  console.log(`Starting multipart upload for ${key} (${fileData.length} bytes)`);
  
  // Create multipart upload
  const createCommand = new CreateMultipartUploadCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
  });
  
  const createResult = await s3Client.send(createCommand);
  const uploadId = createResult.UploadId;
  
  try {
    const parts = [];
    let partNumber = 1;
    
    // Upload parts in chunks
    for (let start = 0; start < fileData.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, fileData.length);
      const chunk = fileData.slice(start, end);
      
      console.log(`Uploading part ${partNumber} (${chunk.length} bytes)`);
      
      const uploadPartCommand = new UploadPartCommand({
        Bucket: bucketName,
        Key: key,
        PartNumber: partNumber,
        UploadId: uploadId,
        Body: chunk,
      });
      
      const partResult = await s3Client.send(uploadPartCommand);
      parts.push({
        ETag: partResult.ETag,
        PartNumber: partNumber,
      });
      
      partNumber++;
    }
    
    // Complete multipart upload
    const completeCommand = new CompleteMultipartUploadCommand({
      Bucket: bucketName,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    });
    
    const result = await s3Client.send(completeCommand);
    console.log(`Multipart upload completed for ${key}`);
    return result;
    
  } catch (error) {
    console.error(`Multipart upload failed for ${key}:`, error);
    // You might want to abort the multipart upload here
    throw error;
  }
}

// Memory-efficient version that streams from file path
async function uploadLargeFileFromPath(filePath, bucketName, key, contentType) {
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  const chunkSize = 25 * 1024 * 1024; // 25MB chunks for S3 multipart
  
  if (fileSize <= chunkSize) {
    // File is small enough for regular upload
    const fileStream = fs.createReadStream(filePath);
    const uploadCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fileStream,
      ContentType: contentType,
    });
    return await s3Client.send(uploadCommand);
  }

  console.log(`Starting streaming multipart upload for ${key} (${fileSize} bytes)`);
  
  // Create multipart upload
  const createCommand = new CreateMultipartUploadCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
  });
  
  const createResult = await s3Client.send(createCommand);
  const uploadId = createResult.UploadId;
  
  try {
    const parts = [];
    let partNumber = 1;
    
    // Upload parts by reading chunks from file
    for (let start = 0; start < fileSize; start += chunkSize) {
      const end = Math.min(start + chunkSize, fileSize);
      const chunkLength = end - start;
      
      // Read chunk from file without loading entire file into memory
      const chunk = Buffer.alloc(chunkLength);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, chunk, 0, chunkLength, start);
      fs.closeSync(fd);
      
      console.log(`📤 Uploading part ${partNumber} (${chunkLength} bytes) from offset ${start}`);
      
      const uploadPartCommand = new UploadPartCommand({
        Bucket: bucketName,
        Key: key,
        PartNumber: partNumber,
        UploadId: uploadId,
        Body: chunk,
      });
      
      const partResult = await s3Client.send(uploadPartCommand);
      parts.push({
        ETag: partResult.ETag,
        PartNumber: partNumber,
      });
      
      partNumber++;
    }
    
    // Complete multipart upload
    const completeCommand = new CompleteMultipartUploadCommand({
      Bucket: bucketName,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    });
    
    const result = await s3Client.send(completeCommand);
    console.log(`Streaming multipart upload completed for ${key}`);
    return result;
    
  } catch (error) {
    console.error(`Streaming multipart upload failed for ${key}:`, error);
    throw error;
  }
}

// Configure S3 client for Backblaze B2
const s3Client = new S3Client({
  region: 'us-east-005',
  endpoint: 'https://s3.us-east-005.backblazeb2.com',
  forcePathStyle: true,
  credentials: {
    accessKeyId: '005b37c1a06d8720000000003',
    secretAccessKey: 'K005bgQ4iRKPrjaqphNadA7p5fulKnQ',
  },
});

const BUCKET_NAME = 'ISTARTX';

// Debug: Log configuration
console.log('S3 Configuration:');
console.log('- Region: us-east-005');
console.log('- Endpoint: https://s3.us-east-005.backblazeb2.com');
console.log('- Bucket: ISTARTX');
console.log('- Access Key: Set');

// Serve the upload form
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'upload.html'));
});

// Serve the local test page at /local_test.html
app.get('/local_test.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'local_test.html'));
});

// Serve the local test page at /test as well (backup route)
app.get('/test', (req, res) => {
  res.sendFile(path.join(__dirname, 'local_test.html'));
});

// Serve the admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeUploads: activeUploads.size,
    memory: process.memoryUsage(),
    version: '1.0.0'
  });
});

// Connection test endpoint
app.get('/ping', (req, res) => {
  res.json({ 
    pong: true, 
    timestamp: Date.now(),
    server: 'IstartX Upload Server'
  });
});

// Serve upload form for panel integration
app.get('/panel/upload', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel-upload.html'));
});

// Initialize chunked upload
app.post('/upload/init', (req, res) => {
  try {
    const { fileName, fileSize, userId = 'guest' } = req.body;
    
    if (!fileName || !fileSize) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: fileName and fileSize' 
      });
    }
    
    const uploadId = crypto.randomBytes(16).toString('hex');
    const finalFileName = generateRandomFilename(fileName);
    
    activeUploads.set(uploadId, {
      fileName: finalFileName,
      originalFileName: fileName,
      userId: userId,
      fileSize: parseInt(fileSize),
      chunks: new Map(),
      createdAt: Date.now()
    });
    
    console.log(`✅ Initialized chunked upload: ${uploadId} for ${fileName} (${fileSize} bytes)`);
    
    res.json({
      success: true,
      uploadId: uploadId,
      finalFileName: finalFileName,
      timestamp: Date.now()
    });
  } catch (error) {
    console.error('❌ Upload init error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Upload individual chunk
app.post('/upload/chunk', chunkUpload.single('chunk'), (req, res) => {
  try {
    const { uploadId, chunkIndex } = req.body;
    const chunkFile = req.file;
    
    if (!chunkFile) {
      return res.status(400).json({ success: false, error: 'No chunk data' });
    }
    
    const uploadInfo = activeUploads.get(uploadId);
    if (!uploadInfo) {
      // Clean up the uploaded chunk file since upload session doesn't exist
      try {
        fs.unlinkSync(chunkFile.path);
        console.log(`🗑️ Cleaned up orphaned chunk: ${chunkFile.path} (no upload session)`);
      } catch (cleanupError) {
        console.error(`Error cleaning up orphaned chunk:`, cleanupError);
      }
      return res.status(404).json({ success: false, error: 'Upload session not found' });
    }
    
    // Store chunk info
    uploadInfo.chunks.set(parseInt(chunkIndex), {
      path: chunkFile.path,
      size: chunkFile.size
    });
    
    console.log(`Received chunk ${chunkIndex} for upload ${uploadId} (${chunkFile.size} bytes)`);
    
    res.json({
      success: true,
      chunkIndex: parseInt(chunkIndex),
      receivedChunks: uploadInfo.chunks.size
    });
  } catch (error) {
    console.error('Chunk upload error:', error);
    
    // Clean up the chunk file on error
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
        console.log(`🗑️ Cleaned up chunk due to error: ${req.file.path}`);
      } catch (cleanupError) {
        console.error(`Error cleaning up chunk on error:`, cleanupError);
      }
    }
    
    res.status(500).json({ success: false, error: error.message });
  }
});

// Complete chunked upload
app.post('/upload/complete', async (req, res) => {
  try {
    const { uploadId } = req.body;
    const uploadInfo = activeUploads.get(uploadId);
    
    if (!uploadInfo) {
      return res.status(404).json({ success: false, error: 'Upload session not found' });
    }
    
    console.log(`Completing upload ${uploadId} with ${uploadInfo.chunks.size} chunks`);
    
    // Combine chunks into final file using streaming approach
    const finalKey = `${uploadInfo.userId}/${uploadInfo.fileName}`;
    const chunks = Array.from(uploadInfo.chunks.entries()).sort(([a], [b]) => a - b);
    
    // Create a temporary combined file path
    const tempFilePath = path.join(__dirname, 'uploads', `temp_${uploadId}_${Date.now()}.tmp`);
    
    // Combine chunks by streaming them to a temporary file
    const writeStream = fs.createWriteStream(tempFilePath);
    let totalSize = 0;
    
    for (const [index, chunkInfo] of chunks) {
      const chunkData = fs.readFileSync(chunkInfo.path);
      writeStream.write(chunkData);
      totalSize += chunkData.length;
      console.log(`📦 Combined chunk ${index} (${chunkData.length} bytes)`);
    }
    writeStream.end();
    
    // Wait for write stream to finish
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    console.log(`Combined file size: ${totalSize} bytes`);
    
    // Upload the temporary file to B2 using file stream to avoid memory issues
    await uploadLargeFileFromPath(tempFilePath, BUCKET_NAME, finalKey, 'application/octet-stream');
    
    // Clean up temporary file
    try {
      fs.unlinkSync(tempFilePath);
      console.log(`🗑️ Cleaned up temporary file: ${tempFilePath}`);
    } catch (tempCleanupError) {
      console.error(`Error cleaning up temporary file:`, tempCleanupError);
    }
    
    // Cleanup chunks (enhanced cleanup)
    let cleanedChunks = 0;
    let failedCleanups = 0;
    chunks.forEach(([index, chunkInfo]) => {
      try {
        if (fs.existsSync(chunkInfo.path)) {
          fs.unlinkSync(chunkInfo.path);
          cleanedChunks++;
        }
      } catch (cleanupError) {
        console.error(`Error cleaning up chunk ${chunkInfo.path}:`, cleanupError);
        failedCleanups++;
      }
    });
    
    console.log(`🧹 Cleanup: ${cleanedChunks} chunks removed, ${failedCleanups} failed cleanups`);
    
    // Remove from active uploads
    activeUploads.delete(uploadId);
    
    // Generate both CDN and direct B2 URLs for testing
    const cdnUrl = `https://cdn.istartx.io/${finalKey}`;
    const b2Url = `https://s3.us-east-005.backblazeb2.com/ISTARTX/${finalKey}`;
    const b2PublicUrl = `https://f005.backblazeb2.com/file/ISTARTX/${finalKey}`;
    
    console.log(`File uploaded successfully:`);
    console.log(`- B2 Key: ${finalKey}`);
    console.log(`- CDN URL: ${cdnUrl}`);
    console.log(`- B2 Direct URL: ${b2Url}`);
    console.log(`- B2 Public URL: ${b2PublicUrl}`);
    
    res.json({
      success: true,
      userId: uploadInfo.userId,
      originalFileName: uploadInfo.originalFileName,
      finalFileName: uploadInfo.fileName,
      cdnUrl: cdnUrl,
      b2Url: b2Url,
      b2PublicUrl: b2PublicUrl,
      b2Key: finalKey,
      fileSize: totalSize
    });
    
    console.log(`Successfully completed chunked upload: ${uploadInfo.originalFileName} → ${uploadInfo.fileName}`);
    
  } catch (error) {
    console.error('Upload complete error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Manual cleanup endpoint (for admin use)
app.post('/admin/cleanup', (req, res) => {
  try {
    cleanupOrphanedChunks();
    res.json({ success: true, message: 'Manual cleanup initiated' });
  } catch (error) {
    console.error('Manual cleanup error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Storage status endpoint
app.get('/admin/storage-status', (req, res) => {
  try {
    const uploadsDir = path.join(__dirname, 'uploads');
    const chunksDir = path.join(__dirname, 'uploads/chunks');
    
    let totalFiles = 0;
    let totalSize = 0;
    let chunkFiles = 0;
    let chunkSize = 0;
    let tempFiles = 0;
    let tempSize = 0;
    
    // Count chunk files
    if (fs.existsSync(chunksDir)) {
      const chunks = fs.readdirSync(chunksDir);
      chunkFiles = chunks.length;
      chunks.forEach(chunk => {
        try {
          const stats = fs.statSync(path.join(chunksDir, chunk));
          chunkSize += stats.size;
        } catch (error) {
          // Ignore errors for individual files
        }
      });
    }
    
    // Count temp files
    if (fs.existsSync(uploadsDir)) {
      const temps = fs.readdirSync(uploadsDir).filter(file => !file.includes('chunks'));
      tempFiles = temps.length;
      temps.forEach(temp => {
        try {
          const stats = fs.statSync(path.join(uploadsDir, temp));
          tempSize += stats.size;
        } catch (error) {
          // Ignore errors for individual files
        }
      });
    }
    
    totalFiles = chunkFiles + tempFiles;
    totalSize = chunkSize + tempSize;
    
    res.json({
      success: true,
      storage: {
        totalFiles: totalFiles,
        totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
        chunks: {
          files: chunkFiles,
          sizeMB: Math.round(chunkSize / 1024 / 1024 * 100) / 100
        },
        tempFiles: {
          files: tempFiles,
          sizeMB: Math.round(tempSize / 1024 / 1024 * 100) / 100
        },
        activeUploads: activeUploads.size
      },
      cleanupConfig: CLEANUP_CONFIG
    });
  } catch (error) {
    console.error('Storage status error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint for upload (can be used via AJAX)
app.get('/admin/files', (req, res) => {
  res.sendFile(path.join(__dirname, 'upload.html'));
});

// Handle file uploads and upload to B2
app.post('/upload', upload.array('myfiles'), async (req, res) => {
  try {
    const userId = req.body.user_id || 'guest';
    
    // Check if files were uploaded
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No files selected',
        message: 'Please select at least one file to upload.'
      });
    }

    const results = [];
    const errors = [];
    
    console.log(`Starting upload of ${req.files.length} file(s) for user: ${userId}`);
    
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      
      try {
        console.log(`Processing file ${i + 1}/${req.files.length}: ${file.originalname}`);
        console.log(`File path: ${file.path}`);
        console.log(`File size: ${file.size} bytes`);
        console.log(`MIME type: ${file.mimetype}`);
        
        // Generate random filename
        const randomFilename = generateRandomFilename(file.originalname);
        console.log(`Generated random filename: ${randomFilename}`);
        
        // Check if random filename exists (very unlikely but just in case)
        let finalFilename = randomFilename;
        let suffix = 1;
        
        while (true) {
          const b2Key = `${userId}/${finalFilename}`;
          
          try {
            // Check if file exists using headObject
            await s3Client.send(new HeadObjectCommand({
              Bucket: BUCKET_NAME,
              Key: b2Key,
            }));
            
            // File exists (very unlikely with random names), add suffix
            const fileInfo = path.parse(randomFilename);
            finalFilename = `${fileInfo.name}_${suffix}${fileInfo.ext}`;
            suffix++;
          } catch (error) {
            // File doesn't exist (expected), we can use this filename
            if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
              break;
            }
            // Some other error occurred, break and try to upload
            break;
          }
        }

        // Read file data
        const fileData = fs.readFileSync(file.path);
        const finalKey = `${userId}/${finalFilename}`;

        console.log(`Uploading to B2: ${finalKey}`);
        console.log(`File size: ${fileData.length} bytes`);

        // Use chunked upload for large files, regular upload for small files
        const uploadResult = await uploadLargeFile(
          fileData, 
          BUCKET_NAME, 
          finalKey, 
          file.mimetype || 'application/octet-stream'
        );
        
        console.log(`Upload successful: ${finalKey}`);

        // Build multiple URLs for testing which one works
        const cdnUrl = `https://cdn.istartx.io/${finalKey}`;
        const b2Url = `https://s3.us-east-005.backblazeb2.com/ISTARTX/${finalKey}`;
        const b2PublicUrl = `https://f005.backblazeb2.com/file/ISTARTX/${finalKey}`;
        
        console.log(`File URLs generated:`);
        console.log(`- CDN URL: ${cdnUrl}`);
        console.log(`- B2 Direct URL: ${b2Url}`);
        console.log(`- B2 Public URL: ${b2PublicUrl}`);

        results.push({
          success: true,
          userId: userId,
          originalFileName: file.originalname,
          finalFileName: finalFilename,
          cdnUrl: cdnUrl,
          b2Url: b2Url,
          b2PublicUrl: b2PublicUrl,
          b2Key: finalKey,
          fileSize: file.size,
          mimeType: file.mimetype,
        });

        console.log(`Successfully uploaded: ${file.originalname} → ${finalFilename}`);

      } catch (fileError) {
        console.error(`Error uploading file ${file.originalname}:`, fileError);
        errors.push({
          success: false,
          fileName: file.originalname,
          error: fileError.message
        });
      } finally {
        // Clean up local temp file
        try {
          if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
          }
        } catch (cleanupError) {
          console.error(`Error cleaning up temp file ${file.path}:`, cleanupError);
        }
      }
    }

    // Return JSON response
    const successCount = results.length;
    const errorCount = errors.length;
    const totalCount = successCount + errorCount;

    // Check if request wants JSON response (for API calls)
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({
        success: successCount > 0,
        userId: userId,
        summary: {
          total: totalCount,
          successful: successCount,
          failed: errorCount
        },
        files: results,
        errors: errors
      });
    }

    // Return HTML response for form submissions
    res.send(`
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 20px auto; padding: 20px; }
        .summary { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .success { background: #d4edda; border: 1px solid #c3e6cb; color: #155724; padding: 10px; border-radius: 5px; margin: 10px 0; }
        .error { background: #f8d7da; border: 1px solid #f5c6cb; color: #721c24; padding: 10px; border-radius: 5px; margin: 10px 0; }
        .file-item { background: #fff; border: 1px solid #dee2e6; padding: 15px; margin: 10px 0; border-radius: 5px; }
        .file-name { font-weight: bold; color: #007bff; }
        .file-details { font-size: 0.9em; color: #6c757d; margin-top: 5px; }
        .cdn-url { word-break: break-all; background: #f8f9fa; padding: 5px; border-radius: 3px; margin-top: 5px; }
        .back-btn { display: inline-block; background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 20px; }
        .back-btn:hover { background: #0056b3; }
      </style>
      
      <h2>Upload Results for User: ${userId}</h2>
      
      <div class="summary">
        <strong>Summary:</strong> ${successCount} of ${totalCount} files uploaded successfully
        ${errorCount > 0 ? `<br><span style="color: #dc3545;">${errorCount} files failed to upload</span>` : ''}
      </div>
      
      ${successCount > 0 ? `
        <div class="success">
          <h3>✅ Successfully Uploaded Files (${successCount}):</h3>
          ${results.map(r => `
            <div class="file-item">
              <div class="file-name">${r.originalFileName} → ${r.finalFileName}</div>
              <div class="file-details">
                Size: ${(r.fileSize / 1024).toFixed(2)} KB | 
                Type: ${r.mimeType || 'Unknown'}
              </div>
              <div class="cdn-url">
                <strong>CDN URL:</strong> 
                <a href="${r.cdnUrl}" target="_blank">${r.cdnUrl}</a>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      
      ${errorCount > 0 ? `
        <div class="error">
          <h3>❌ Failed Uploads (${errorCount}):</h3>
          ${errors.map(e => `
            <div class="file-item">
              <div class="file-name">${e.fileName}</div>
              <div class="file-details">Error: ${e.error}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      
      <a href="/" class="back-btn">Upload More Files</a>
    `);
    
  } catch (err) {
    console.error('Upload error:', err);
    
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.status(500).json({
        success: false,
        error: err.message
      });
    }
    
    res.status(500).send(`
      <h2>Upload Error</h2>
      <pre>${err.message}</pre>
      <a href="/">Back</a>
    `);
  }
});

// Ensure uploads directories exist
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}
if (!fs.existsSync(path.join(__dirname, 'uploads/chunks'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads/chunks'), { recursive: true });
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // Listen on all interfaces for production
const server = app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}/`);
  
  // Run initial cleanup on startup
  console.log('🧹 Running initial cleanup on startup...');
  setTimeout(cleanupOrphanedChunks, 5000); // Wait 5 seconds for server to be ready
});

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, starting graceful shutdown...');
  
  // Clean up all active uploads
  console.log(`🧹 Cleaning up ${activeUploads.size} active upload sessions...`);
  for (const [uploadId, uploadInfo] of activeUploads.entries()) {
    for (const [chunkIndex, chunkInfo] of uploadInfo.chunks.entries()) {
      try {
        if (fs.existsSync(chunkInfo.path)) {
          fs.unlinkSync(chunkInfo.path);
          console.log(`🗑️ Removed chunk ${chunkIndex} for session ${uploadId}`);
        }
      } catch (error) {
        console.error(`Error cleaning up chunk ${chunkInfo.path}:`, error);
      }
    }
  }
  
  server.close(() => {
    console.log('✅ Server gracefully shut down');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, starting graceful shutdown...');
  process.emit('SIGTERM');
});