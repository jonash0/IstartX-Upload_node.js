const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads/') }); // Temp storage for incoming files

// Add CORS middleware for local testing
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Function to generate random filename
function generateRandomFilename(originalFilename) {
  const fileInfo = path.parse(originalFilename);
  const extension = fileInfo.ext;
  const randomString = crypto.randomBytes(16).toString('hex');
  console.log(`Random filename generation: ${originalFilename} → ${randomString}${extension}`);
  return `${randomString}${extension}`;
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

        // Upload to Backblaze B2 using S3-compatible API
        const uploadCommand = new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: finalKey,
          Body: fileData,
          ContentType: file.mimetype || 'application/octet-stream',
        });

        const uploadResult = await s3Client.send(uploadCommand);
        console.log(`Upload successful: ${finalKey}`);

        // Build CDN URL using your existing CDN
        const cdnUrl = `https://cdn.istartx.io/${finalKey}`;

        results.push({
          success: true,
          userId: userId,
          originalFileName: file.originalname,
          finalFileName: finalFilename,
          cdnUrl: cdnUrl,
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

// Ensure uploads directory exists
if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
});