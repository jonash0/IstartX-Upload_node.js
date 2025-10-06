const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads/') }); // Temp storage for incoming files

// Configure S3 client for Tigris Object Storage
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'auto',
  endpoint: process.env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.BUCKET_NAME || 'istartx-upload-bucket';

// Serve the upload form
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'upload.html'));
});

// Serve upload form for panel integration
app.get('/panel/upload', (req, res) => {
  res.sendFile(path.join(__dirname, 'panel-upload.html'));
});

// API endpoint for upload (can be used via AJAX)
app.get('/admin/files', (req, res) => {
  res.sendFile(path.join(__dirname, 'upload.html'));
});

// Handle file uploads and upload to B2
app.post('/upload', upload.array('myfiles'), async (req, res) => {
  try {
    const userId = req.body.user_id;
    
    // Validate user_id is provided
    if (!userId) {
      return res.status(400).send(`
        <h2>Error: User ID is required</h2>
        <p>Please provide a User ID before uploading files.</p>
        <a href="/">Back</a>
      `);
    }

    // Check if files were uploaded
    if (!req.files || req.files.length === 0) {
      return res.status(400).send(`
        <h2>Error: No files selected</h2>
        <p>Please select at least one file to upload.</p>
        <a href="/">Back</a>
      `);
    }

    const results = [];
    const errors = [];
    
    console.log(`Starting upload of ${req.files.length} file(s) for user: ${userId}`);
    
    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      
      try {
        console.log(`Processing file ${i + 1}/${req.files.length}: ${file.originalname}`);
        
        // Parse filename components (same logic as PHP)
        const originalFilename = file.originalname;
        const fileInfo = path.parse(originalFilename);
        const basename = fileInfo.name;
        const extension = fileInfo.ext;
        
        let b2Filename = originalFilename;
        let suffix = 1;
        
        // Check if file exists and add suffix if needed (same logic as PHP)
        while (true) {
          const b2Key = `${userId}/${b2Filename}`;
          
          try {
            // Check if file exists using headObject (same as PHP headObject)
            await s3Client.send(new HeadObjectCommand({
              Bucket: BUCKET_NAME,
              Key: b2Key,
            }));
            
            // File exists, add suffix
            b2Filename = `${basename}_${suffix}${extension}`;
            suffix++;
          } catch (error) {
            // File doesn't exist (404 error), we can use this filename
            if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
              break;
            }
            // Some other error occurred, break and try to upload
            break;
          }
        }

        // Read file data
        const fileData = fs.readFileSync(file.path);
        const finalKey = `${userId}/${b2Filename}`;

        // Upload to B2 using S3-compatible API
        const uploadCommand = new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: finalKey,
          Body: fileData,
          ContentType: file.mimetype || 'application/octet-stream',
        });

        const uploadResult = await s3Client.send(uploadCommand);

        // Build Tigris CDN URL
        const objectUrl = `https://fly.storage.tigris.dev/${BUCKET_NAME}/${finalKey}`;

        results.push({
          userId: userId,
          originalFileName: originalFilename,
          finalFileName: b2Filename,
          cdnUrl: objectUrl,
          b2Key: finalKey,
          fileSize: file.size,
          mimeType: file.mimetype,
        });

        console.log(`Successfully uploaded: ${originalFilename} → ${b2Filename}`);

      } catch (fileError) {
        console.error(`Error uploading file ${file.originalname}:`, fileError);
        errors.push({
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

    // Generate response with detailed results
    const successCount = results.length;
    const errorCount = errors.length;
    const totalCount = successCount + errorCount;

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
    res.status(500).send(`
      <h2>Upload Error</h2>
      <pre>${err.message}</pre>
      <a href="/">Back</a>
    `);
  }
});

// Ensure uploads directory exists
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});