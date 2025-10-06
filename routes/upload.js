// routes/upload.js - Upload routes for base44.com
const express = require('express');
const router = express.Router();
const { upload, uploadFilesToB2 } = require('../modules/b2Upload');

// Middleware to ensure user is authenticated (adapt to base44.com auth system)
function requireAuth(req, res, next) {
  // Replace with base44.com authentication check
  if (req.session && req.session.user) {
    next();
  } else if (req.headers.authorization) {
    // API key authentication
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
}

// GET /upload - Show upload page
router.get('/', requireAuth, (req, res) => {
  const user = req.session.user || { id: 'guest' };
  res.render('upload', { 
    title: 'File Upload',
    user: user,
    layout: 'admin' // Use base44.com admin layout
  });
});

// POST /upload - Handle file upload
router.post('/', requireAuth, upload, async (req, res) => {
  try {
    const userId = req.body.user_id || req.session.user?.id || 'guest';
    
    // Validate user_id
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Check if files were uploaded
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files selected'
      });
    }

    // Upload files to B2
    const { results, errors } = await uploadFilesToB2(userId, req.files);
    
    const successCount = results.length;
    const errorCount = errors.length;
    const totalCount = successCount + errorCount;

    // For AJAX requests, return JSON
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      return res.json({
        success: errorCount === 0,
        message: `${successCount} of ${totalCount} files uploaded successfully`,
        results: results,
        errors: errors,
        stats: {
          total: totalCount,
          success: successCount,
          failed: errorCount
        }
      });
    }

    // For form submissions, render result page
    res.render('upload-result', {
      title: 'Upload Results',
      userId: userId,
      results: results,
      errors: errors,
      stats: {
        total: totalCount,
        success: successCount,
        failed: errorCount
      },
      layout: 'admin'
    });

  } catch (error) {
    console.error('Upload error:', error);
    
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      res.status(500).json({
        success: false,
        message: 'Upload failed',
        error: error.message
      });
    } else {
      res.render('error', {
        title: 'Upload Error',
        message: 'Upload failed: ' + error.message,
        layout: 'admin'
      });
    }
  }
});

// GET /upload/api - API endpoint for file list or stats
router.get('/api/files/:userId', requireAuth, async (req, res) => {
  // This could be extended to list files from B2 for a user
  res.json({
    message: 'File listing endpoint - implement as needed',
    userId: req.params.userId
  });
});

module.exports = router;