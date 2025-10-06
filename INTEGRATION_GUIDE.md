# Integration Guide for base44.com

## 📋 Steps to Integrate B2 Upload into base44.com

### 1. Install Dependencies
Add to base44.com's package.json:
```bash
npm install multer @aws-sdk/client-s3
```

### 2. Add Environment Variables
Add to base44.com's .env file:
```env
B2_ACCESS_KEY=005b37c1a06d8720000000003
B2_SECRET_KEY=K005bgQ4iRKPrjaqphNadA7p5fulKnQ
B2_BUCKET=ISTARTX
B2_REGION=us-east-005
B2_ENDPOINT=https://s3.us-east-005.backblazeb2.com
CDN_BASE_URL=https://cdn.istartx.io
```

### 3. Copy Files to base44.com Structure
```
base44.com/
├── modules/
│   └── b2Upload.js          ← Copy this module
├── routes/
│   └── upload.js            ← Copy this route
├── views/
│   ├── upload.ejs           ← Copy this template
│   └── upload-result.ejs    ← Create result template
└── public/
    └── js/
        └── upload.js        ← Optional: Extract JS to separate file
```

### 4. Update base44.com's Main App File
In your main app.js or server.js:

```javascript
// Add upload routes
const uploadRoutes = require('./routes/upload');
app.use('/admin/upload', uploadRoutes);  // Access at /admin/upload
// OR
app.use('/upload', uploadRoutes);        // Access at /upload
```

### 5. Add Navigation Menu Item
In your admin navigation template:
```html
<li class="nav-item">
    <a class="nav-link" href="/admin/upload">
        <i class="fas fa-cloud-upload-alt"></i>
        File Upload
    </a>
</li>
```

### 6. Create Upload Result Template
Create `views/upload-result.ejs`:
```html
<div class="upload-results">
    <h2>Upload Results for <%= userId %></h2>
    
    <div class="alert alert-info">
        <%= stats.success %> of <%= stats.total %> files uploaded successfully
    </div>
    
    <% if (results.length > 0) { %>
        <h4>✅ Successful Uploads:</h4>
        <% results.forEach(result => { %>
            <div class="card mb-2">
                <div class="card-body">
                    <strong><%= result.originalFileName %></strong> → <%= result.finalFileName %>
                    <br><small>CDN URL: <a href="<%= result.cdnUrl %>" target="_blank"><%= result.cdnUrl %></a></small>
                </div>
            </div>
        <% }); %>
    <% } %>
    
    <% if (errors.length > 0) { %>
        <h4>❌ Failed Uploads:</h4>
        <% errors.forEach(error => { %>
            <div class="alert alert-danger">
                <strong><%= error.fileName %>:</strong> <%= error.error %>
            </div>
        <% }); %>
    <% } %>
    
    <a href="/admin/upload" class="btn btn-primary">Upload More Files</a>
</div>
```

### 7. Authentication Integration
Update the `requireAuth` function in `routes/upload.js` to match base44.com's authentication:

```javascript
function requireAuth(req, res, next) {
    // Replace with base44.com's actual auth check
    if (req.session?.user || req.user) {
        next();
    } else {
        res.redirect('/login');
    }
}
```

### 8. Access URLs
After integration, the upload functionality will be available at:
- **Form:** `https://base44.com/admin/upload`
- **API:** `POST https://base44.com/admin/upload` (with JSON Accept header)

### 9. API Usage
For integrating with existing base44.com features:

```javascript
// Upload files via JavaScript/AJAX
const formData = new FormData();
formData.append('user_id', currentUser.id);
formData.append('files', fileInput.files[0]);

fetch('/admin/upload', {
    method: 'POST',
    body: formData,
    headers: { 'Accept': 'application/json' }
})
.then(response => response.json())
.then(data => {
    if (data.success) {
        console.log('Upload successful:', data.results);
    }
});
```

### 10. Customization Options
- Modify templates to match base44.com's design system
- Update authentication to use base44.com's user system
- Add file type restrictions if needed
- Implement user quotas or upload limits
- Add file management features (list, delete, etc.)

## 🚀 Benefits
- ✅ Seamless integration with existing base44.com interface
- ✅ Uses base44.com's authentication system
- ✅ Matches base44.com's design and navigation
- ✅ API endpoint for programmatic uploads
- ✅ File conflict resolution
- ✅ CDN URL generation
- ✅ User-specific file organization