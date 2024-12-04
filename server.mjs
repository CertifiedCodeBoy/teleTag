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

app.get('/', (req, res) => {
  res.send('Server is running');
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
