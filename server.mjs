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
app.use(express.json());


// Webhook endpoint
app.post('/webhook', (req, res, next) => {
  handler(req, res, next); // Use your existing handler
});

app.get('/', (req, res) => {
  res.send('Server is running');
});


// Start the server
server = app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

// body parser middleware

// const bodyString = await readStream(event.body); //for Netlify functions
const bodyString = event.body; // For Express, you can directly access req.body

// const body = JSON.parse(bodyString); // For Netlify functions, 
const body = bodyString; // For Express, you can directly access req.body


// res for the webhook response
res.status(200).send("OK"); // For Express, send a response directly
    // return new Response( // For Netlify functions, you can return a Response object
    //   JSON.stringify({ message: "Message processed successfully" }),
    //   { status: 200, headers: { "Content-Type": "application/json" } }
    // );