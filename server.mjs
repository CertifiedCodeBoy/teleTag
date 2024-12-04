import express from 'express';
import bodyParser from 'body-parser';
import handler from './netlify/functions/bot.mjs';
import dotenv from 'dotenv';
import http from 'http';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

let ongoingRequests = new Map();
let isResetting = false; // Flag to prevent new requests during reset
let server;
const connections = new Set(); // Track open connections

// Middleware to track requests and handle resets
app.use(bodyParser.json());

app.use((req, res, next) => {
  if (isResetting) {
    return res.status(503).json({ message: 'Server is resetting, please try again later.' });
  }

  const controller = new AbortController();
  const requestId = req.id || Date.now().toString();

  ongoingRequests.set(requestId, controller);

  const cleanup = () => ongoingRequests.delete(requestId);
  res.on('finish', cleanup);
  res.on('close', cleanup);

  req.controller = controller;
  next();
});

// Webhook endpoint
app.post('/webhook', (req, res, next) => {
  handler(req, res, next); // Use your existing handler
});

// Endpoint to hard reset the server
app.get('/reset', async (req, res) => {
  if (isResetting) {
    return res.json({ message: 'Reset is already in progress.' });
  }
  console.time('Reset Time');
  isResetting = true;

  // Abort all ongoing requests
  for (const [, controller] of ongoingRequests) {
    controller.abort();
  }
  ongoingRequests.clear();

  // Force-close all open connections
  for (const socket of connections) {
    socket.destroy();
  }
  connections.clear();

  // Close the server
  await new Promise((resolve) => {
    server.close(() => {
      console.log('Server has been shut down.');
      resolve();
    });
  });

  // Restart the server
  server = app.listen(port, () => {
    console.log(`Server restarted on port ${port}`);
    isResetting = false;
    console.timeEnd('Reset Time');
    res.json({ message: 'Server has been hard reset and restarted.' });
  });
});

// Track active connections for forced shutdown
app.on('connection', (socket) => {
  connections.add(socket);
  socket.on('close', () => connections.delete(socket));
});

// Start the server
server = app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
