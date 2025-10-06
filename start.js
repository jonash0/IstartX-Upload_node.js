#!/usr/bin/env node

// Production startup script
const { spawn } = require('child_process');
const path = require('path');

console.log('Starting B2 Upload Server...');

const serverPath = path.join(__dirname, 'server.js');
const server = spawn('node', [serverPath], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production'
  }
});

server.on('error', (err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

server.on('exit', (code) => {
  console.log(`Server exited with code ${code}`);
  if (code !== 0) {
    console.log('Restarting server...');
    // Auto-restart on crash
    setTimeout(() => {
      require('./start.js');
    }, 5000);
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.kill('SIGTERM');
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  server.kill('SIGINT');
});