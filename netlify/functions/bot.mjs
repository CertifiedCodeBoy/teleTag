import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const bot = new TelegramBot(process.env.TOKEN);

// Configuration
const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  CACHE_TTL: 5 * 60 * 1000, // 5 minutes
  MAX_CONVERSATION_HISTORY: 20,
  MAX_MESSAGE_LENGTH: 4000,
  MAX_PROMPT_LENGTH: 30000, // Increased to near Gemini's limit (32k tokens ≈ 24-30k characters)
  MAX_CONTEXT_LENGTH: 25000, // Maximum context including history
  RATE_LIMIT: {
    window: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute per user
  },
};

// Rate limiting
const userRateLimit = new Map();

// Simple cache implementation
const cache = new Map();

class DatabaseManager {
  constructor() {
    this.client = new MongoClient(process.env.MONGO_URI, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    this.db = null;
    this.isConnected = false;
  }

  async connect() {
    if (!this.isConnected) {
      try {
        await this.client.connect();
        this.db = this.client.db("teleTag");
        this.isConnected = true;
        console.log("Connected to MongoDB");

        // Create indexes for better performance
        await this.createIndexes();
      } catch (err) {
        console.error("Error connecting to MongoDB", err);
        throw err;
      }
    }
    return this.db;
  }

  async createIndexes() {
    try {
      await this.db.collection("groupMembers").createIndex({ chatId: 1 });
      await this.db.collection("helpers").createIndex({ chatId: 1 });
      await this.db.collection("reminders").createIndex({ chatId: 1 });
      await this.db.collection("aiConversations").createIndex({ chatId: 1, userId: 1 });
      await this.db.collection("apiUsage").createIndex({ date: 1 }, { expireAfterSeconds: 86400 });
    } catch (error) {
      console.error("Error creating indexes:", error);
    }
  }

  async disconnect() {
    if (this.isConnected) {
      await this.client.close();
      this.isConnected = false;
    }
  }

  getCollection(name) {
    if (!this.isConnected) {
      throw new Error("Database not connected");
    }
    return this.db.collection(name);
  }
}

const dbManager = new DatabaseManager();

// Enhanced error handling
class BotError extends Error {
  constructor(message, code, statusCode = 500) {
    super(message);
    this.name = "BotError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Rate limiting function
function checkRateLimit(userId) {
  const now = Date.now();
  const userKey = `user_${userId}`;

  if (!userRateLimit.has(userKey)) {
    userRateLimit.set(userKey, { requests: 1, resetTime: now + CONFIG.RATE_LIMIT.window });
    return true;
  }

  const userData = userRateLimit.get(userKey);

  if (now > userData.resetTime) {
    userData.requests = 1;
    userData.resetTime = now + CONFIG.RATE_LIMIT.window;
    return true;
  }

  if (userData.requests >= CONFIG.RATE_LIMIT.max) {
    return false;
  }

  userData.requests++;
  return true;
}

// Enhanced cache functions
function getCacheKey(type, ...args) {
  return `${type}_${args.join("_")}`;
}

function getFromCache(key) {
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiry) {
    return cached.data;
  }
  cache.delete(key);
  return null;
}

function setCache(key, data, ttl = CONFIG.CACHE_TTL) {
  cache.set(key, {
    data,
    expiry: Date.now() + ttl,
  });
}

// Enhanced API usage tracking
async function trackAPIUsage() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const collection = dbManager.getCollection("apiUsage");

    await collection.updateOne(
      { date: today },
      {
        $inc: { count: 1 },
        $setOnInsert: { date: today, created: new Date() },
      },
      { upsert: true }
    );
  } catch (error) {
    console.error("Error tracking API usage:", error);
  }
}

async function getAPIUsage() {
  try {
    const today = new Date().toISOString().split("T")[0];
    const collection = dbManager.getCollection("apiUsage");
    const usage = await collection.findOne({ date: today });
    return usage?.count || 0;
  } catch (error) {
    console.error("Error getting API usage:", error);
    return 0;
  }
}

// Enhanced Gemini API call with retry logic
async function callGeminiAPI(prompt, retries = CONFIG.MAX_RETRIES) {
  if (!prompt || typeof prompt !== "string") {
    throw new BotError("Invalid prompt provided", "INVALID_PROMPT", 400);
  }

  if (prompt.length > CONFIG.MAX_PROMPT_LENGTH) {
    throw new BotError("Prompt too long", "PROMPT_TOO_LONG", 400);
  }

  try {
    await trackAPIUsage();

    if (!process.env.GEMINI_API_KEY) {
      throw new BotError("GEMINI_API_KEY not found in environment variables", "MISSING_API_KEY", 500);
    }

    const model = "gemini-1.5-flash";
    const baseURL = "https://generativelanguage.googleapis.com/v1beta/models";

    const response = await fetch(
      `${baseURL}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            topP: 0.9,
            maxOutputTokens: 2048, // Increased output tokens for longer responses
            responseMimeType: "text/plain",
          },
          safetySettings: [
            {
              category: "HARM_CATEGORY_HARASSMENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE",
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              threshold: "BLOCK_MEDIUM_AND_ABOVE",
            },
            {
              category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE",
            },
            {
              category: "HARM_CATEGORY_DANGEROUS_CONTENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE",
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Gemini API Error:", errorData);

      if (response.status === 429 || errorData.error?.message?.includes("quota")) {
        throw new BotError("QUOTA_EXCEEDED", "QUOTA_EXCEEDED", 429);
      }

      // Retry on server errors
      if (response.status >= 500 && retries > 0) {
        console.log(`Retrying API call... ${retries} attempts left`);
        await new Promise((resolve) => setTimeout(resolve, CONFIG.RETRY_DELAY));
        return callGeminiAPI(prompt, retries - 1);
      }

      throw new BotError(
        `Gemini API error: ${response.status} - ${errorData.error?.message || "Unknown error"}`,
        "API_ERROR",
        response.status
      );
    }

    const data = await response.json();

    if (!data.candidates || data.candidates.length === 0) {
      throw new BotError("No response generated from Gemini API", "NO_RESPONSE", 500);
    }

    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error("Gemini API Error:", error);

    if (error instanceof BotError) {
      throw error;
    }

    // Retry on network errors
    if (error.name === "TypeError" && retries > 0) {
      console.log(`Retrying due to network error... ${retries} attempts left`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return callGeminiAPI(prompt, retries - 1);
    }

    throw new BotError("Network error connecting to Gemini API", "NETWORK_ERROR", 500);
  }
}

// Enhanced database functions with caching
async function getGroupMembers(chatId) {
  const cacheKey = getCacheKey("members", chatId);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const collection = dbManager.getCollection("groupMembers");
  const groupData = await collection.findOne({ chatId });
  const result = groupData || { chatId, members: [] };

  setCache(cacheKey, result);
  return result;
}

async function updateGroupMembers(chatId, members) {
  const collection = dbManager.getCollection("groupMembers");
  const result = await collection.updateOne(
    { chatId },
    { $set: { members, lastUpdated: new Date() } },
    { upsert: true }
  );

  // Invalidate cache
  const cacheKey = getCacheKey("members", chatId);
  cache.delete(cacheKey);

  return result;
}

async function getHelpers(chatId) {
  const cacheKey = getCacheKey("helpers", chatId);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const collection = dbManager.getCollection("helpers");
  const helpersData = await collection.findOne({ chatId });
  const result = helpersData || { chatId, helpers: [] };

  setCache(cacheKey, result);
  return result;
}

async function updateHelpers(chatId, helpers) {
  const collection = dbManager.getCollection("helpers");
  const result = await collection.updateOne(
    { chatId },
    { $set: { helpers, lastUpdated: new Date() } },
    { upsert: true }
  );

  // Invalidate cache
  const cacheKey = getCacheKey("helpers", chatId);
  cache.delete(cacheKey);

  return result;
}

async function getReminders(chatId) {
  const cacheKey = getCacheKey("reminders", chatId);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const collection = dbManager.getCollection("reminders");
  const remindersData = await collection.findOne({ chatId });
  const result = remindersData || { chatId, reminders: [] };

  setCache(cacheKey, result);
  return result;
}

async function updateReminders(chatId, reminders) {
  const collection = dbManager.getCollection("reminders");
  const result = await collection.updateOne(
    { chatId },
    { $set: { reminders, lastUpdated: new Date() } },
    { upsert: true }
  );

  // Invalidate cache
  const cacheKey = getCacheKey("reminders", chatId);
  cache.delete(cacheKey);

  return result;
}

// Enhanced AI conversation functions
async function getAIConversation(chatId, userId) {
  const collection = dbManager.getCollection("aiConversations");
  const conversation = await collection.findOne({ chatId, userId });
  return conversation?.messages || [];
}

async function saveAIConversation(chatId, userId, messages) {
  const collection = dbManager.getCollection("aiConversations");
  await collection.updateOne(
    { chatId, userId },
    {
      $set: {
        messages: messages.slice(-CONFIG.MAX_CONVERSATION_HISTORY),
        lastUpdated: new Date(),
      },
    },
    { upsert: true }
  );
}

async function generateAIResponse(prompt, chatId, userId) {
  try {
    if (!checkRateLimit(userId)) {
      return "⚠️ Rate limit exceeded. Please wait a moment before sending another request.";
    }

    // Sanitize and truncate prompt early
    const sanitizedPrompt = sanitizeInput(prompt);
    if (sanitizedPrompt.length > CONFIG.MAX_PROMPT_LENGTH) {
      return "❌ Your message is too long. Please keep it under 30,000 characters.";
    }

    const history = await getAIConversation(chatId, userId);
    let fullPrompt = "You are a helpful AI assistant in a Telegram group chat. Keep responses concise and helpful. ";

    if (history.length > 0) {
      fullPrompt += "Previous conversation:\n";
      // Dynamically adjust history based on available space
      const basePromptLength = fullPrompt.length + sanitizedPrompt.length + 50; // Buffer
      const availableSpace = CONFIG.MAX_CONTEXT_LENGTH - basePromptLength;
      
      if (availableSpace > 500) {
        let historyText = "";
        const recentHistory = history.slice(-15); // Increased from 5 to 15
        
        for (let i = recentHistory.length - 1; i >= 0; i--) {
          const msg = recentHistory[i];
          const msgText = `${msg.role}: ${msg.content}\n`;
          
          if (historyText.length + msgText.length < availableSpace) {
            historyText = msgText + historyText;
          } else {
            break;
          }
        }
        
        fullPrompt += historyText;
      }
      fullPrompt += "\n";
    }

    fullPrompt += `User: ${sanitizedPrompt}`;

    // Final check for prompt length with more generous limits
    if (fullPrompt.length > CONFIG.MAX_CONTEXT_LENGTH) {
      // Smart truncation: keep the most recent context
      const basePrompt = "You are a helpful AI assistant in a Telegram group chat. Keep responses concise and helpful. ";
      const userPrompt = `User: ${sanitizedPrompt}`;
      const availableForHistory = CONFIG.MAX_CONTEXT_LENGTH - basePrompt.length - userPrompt.length - 100;
      
      if (availableForHistory > 200 && history.length > 0) {
        let contextHistory = "Recent conversation:\n";
        const recentHistory = history.slice(-10);
        
        for (let i = recentHistory.length - 1; i >= 0; i--) {
          const msg = recentHistory[i];
          const msgText = `${msg.role}: ${msg.content.substring(0, 500)}\n`; // Limit each message to 500 chars
          
          if (contextHistory.length + msgText.length < availableForHistory) {
            contextHistory = msgText + contextHistory;
          } else {
            break;
          }
        }
        
        fullPrompt = basePrompt + contextHistory + "\n" + userPrompt;
      } else {
        fullPrompt = basePrompt + userPrompt;
      }
      
      if (fullPrompt.length > CONFIG.MAX_PROMPT_LENGTH) {
        return "❌ Your message is too long even after optimization. Please shorten it.";
      }
    }

    const aiResponse = await callGeminiAPI(fullPrompt);

    if (aiResponse && !aiResponse.includes("Sorry, I'm having trouble")) {
      const newMessages = [
        ...history,
        { role: "user", content: sanitizedPrompt, timestamp: new Date() },
        { role: "assistant", content: aiResponse, timestamp: new Date() },
      ];

      await saveAIConversation(chatId, userId, newMessages);
    }

    return aiResponse;
  } catch (error) {
    console.error("AI Error:", error);

    if (error instanceof BotError) {
      switch (error.code) {
        case "QUOTA_EXCEEDED":
          return "⚠️ API quota exceeded! You've reached your free tier limit. Please try again tomorrow or upgrade your plan.";
        case "RATE_LIMIT":
          return "⚠️ Too many requests. Please wait a moment before trying again.";
        case "INVALID_PROMPT":
          return "❌ Invalid input provided. Please check your message and try again.";
        case "PROMPT_TOO_LONG":
          return "❌ Your message is too long. Please keep it under 30,000 characters.";
        default:
          return "Sorry, I'm having trouble processing your request right now.";
      }
    }

    return "Sorry, I'm having trouble processing your request right now.";
  }
}

// Enhanced utility functions
function sanitizeInput(text) {
  if (typeof text !== "string") return "";
  return text.trim().substring(0, CONFIG.MAX_MESSAGE_LENGTH);
}

function isValidDate(date) {
  if (typeof date !== "string") return false;

  const dateParts = date.split("-");
  if (dateParts.length !== 3) return false;

  const year = parseInt(dateParts[0]);
  const month = parseInt(dateParts[1]);
  const day = parseInt(dateParts[2]);

  if (isNaN(year) || isNaN(month) || isNaN(day)) return false;
  if (year < 2024 || year > 2030) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const currentDate = new Date();
  const inputDate = new Date(year, month - 1, day);

  if (inputDate <= currentDate) return false;
  if (inputDate.getMonth() !== month - 1) return false;

  return true;
}

async function translateText(text) {
  const sanitized = sanitizeInput(text);
  
  // Handle very long texts by chunking if needed
  if (sanitized.length > 20000) {
    const chunks = [];
    for (let i = 0; i < sanitized.length; i += 20000) {
      chunks.push(sanitized.substring(i, i + 20000));
    }
    
    const translations = [];
    for (const chunk of chunks) {
      const prompt = `Translate the following text to English. If it's already in English, translate to Arabic. Only provide the translation:\n\n${chunk}`;
      const translation = await callGeminiAPI(prompt);
      translations.push(translation);
    }
    
    return translations.join(' ');
  }
  
  const prompt = `Translate the following text to English. If it's already in English, translate to Arabic. Only provide the translation:\n\n${sanitized}`;
  return await callGeminiAPI(prompt);
}

async function summarizeText(text) {
  const sanitized = sanitizeInput(text);
  
  // Handle very long texts with more detailed summarization instructions
  if (sanitized.length > 20000) {
    const prompt = `Provide a comprehensive summary of the following long text. Break it down into key points and main themes:\n\n${sanitized}`;
    return await callGeminiAPI(prompt);
  }
  
  const prompt = `Summarize the following text in a concise way, highlighting the main points:\n\n${sanitized}`;
  return await callGeminiAPI(prompt);
}

async function readStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let done = false;

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    if (value) chunks.push(value);
    done = readerDone;
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Enhanced API status check
async function checkGeminiAPIStatus() {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      }
    );

    if (!response.ok) {
      throw new Error(`API Status Check Failed: ${response.status}`);
    }

    const data = await response.json();
    return {
      status: "active",
      models: data.models?.length || 0,
      message: "API key is working correctly",
    };
  } catch (error) {
    console.error("API Status Check Error:", error);
    return {
      status: "error",
      models: 0,
      message: error.message,
    };
  }
}

const commands = [
  { command: "mentionall", description: "Mention all members in the group" },
  { command: "join", description: "Join the group" },
  { command: "leave", description: "Leave the group" },
  { command: "showmembers", description: "Show all members in the group" },
  { command: "help", description: "Seek help from one of the helpers" },
  { command: "addtohelp", description: "Join helpers list" },
  { command: "showhelpers", description: "Show all helpers in the group" },
  { command: "leavehelpers", description: "Leave the helpers" },
  {
    command: "setreminder",
    description: "Set a reminder at a specified date YYYY-MM-DD",
  },
  { command: "reminders", description: "View all reminders" },
  {
    command: "clearreminders",
    description: "Clear all reminders for the group",
  },
  {
    command: "clearreminder",
    description: "Clear a specific reminder by index",
  },
  // AI Commands
  { command: "ask", description: "Ask AI a question" },
  { command: "translate", description: "Translate text (reply to message)" },
  { command: "summarize", description: "Summarize text (reply to message)" },
  { command: "clearai", description: "Clear AI conversation history" },
  { command: "credits", description: "Check API usage information" }, // Add this line
];

// Initialize bot commands after ensuring database connection
async function initializeBot() {
  try {
    await dbManager.connect();

    const alreadysetcommands = await bot.getMyCommands();

    if (alreadysetcommands.length !== commands.length) {
      await bot.setMyCommands(commands);
      console.log("Bot commands set successfully");
    } else {
      console.log("Commands already set");
    }
  } catch (error) {
    console.error("Error initializing bot:", error);
    throw error;
  }
}

// Initialize bot
initializeBot().catch(console.error);

// Enhanced staticCommands function with better error handling
async function staticCommands(text, chatId, userId, msg) {
  try {
    const sanitizedText = sanitizeInput(text);

    if (sanitizedText === "/start" || sanitizedText === "/start@tagallesisbabot") {
      await bot.sendMessage(
        chatId,
        "Hello! I'm your AI-powered group assistant. Use /join to join the group or /ask to chat with me!"
      );
    }

    if (sanitizedText === "/join" || sanitizedText === "/join@tagallesisbabot") {
      const groupData = await getGroupMembers(chatId);
      const user = { id: userId, first_name: msg.from.first_name };

      if (!groupData.members.some((member) => member.id === userId)) {
        groupData.members.push(user);
        await updateGroupMembers(chatId, groupData.members);
        await bot.sendMessage(chatId, "You have joined the group!");
      } else {
        await bot.sendMessage(chatId, "You are already a member!");
      }
    }

    if (sanitizedText === "/leave" || sanitizedText === "/leave@tagallesisbabot") {
      const groupData = await getGroupMembers(chatId);
      const userIndex = groupData.members.findIndex(
        (member) => member.id === userId
      );

      if (userIndex !== -1) {
        groupData.members.splice(userIndex, 1);
        await updateGroupMembers(chatId, groupData.members);
        await bot.sendMessage(chatId, "You have left the group!");
      } else {
        await bot.sendMessage(chatId, "You are not a member!");
      }
    }

    if (sanitizedText === "/showmembers" || sanitizedText === "/showmembers@tagallesisbabot") {
      const groupData = await getGroupMembers(chatId);
      const membersMessage = groupData.members.length
        ? groupData.members.map((member) => member.first_name).join(", ")
        : "No members found.";
      await bot.sendMessage(chatId, membersMessage);
    }

    if (sanitizedText === "/mentionall" || sanitizedText === "/mentionall@tagallesisbabot") {
      const groupData = await getGroupMembers(chatId);
      const mentions = groupData.members.map(
        (member) => `[${member.first_name}](tg://user?id=${member.id})`
      );

      const message = mentions.length
        ? mentions.join(" ")
        : "No members to mention.";
      await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    }

    if (sanitizedText === "/addtohelp" || sanitizedText === "/addtohelp@tagallesisbabot") {
      const helpersData = await getHelpers(chatId);
      const helper = { id: userId, first_name: msg.from.first_name };

      if (!helpersData.helpers.some((h) => h.id === userId)) {
        helpersData.helpers.push(helper);
        await updateHelpers(chatId, helpersData.helpers);
        await bot.sendMessage(chatId, "You have joined the helpers!");
      } else {
        await bot.sendMessage(chatId, "You are already a helper!");
      }
    }

    if (sanitizedText === "/showhelpers" || sanitizedText === "/showhelpers@tagallesisbabot") {
      const helpersData = await getHelpers(chatId);
      const helpersMessage = helpersData.helpers.length
        ? helpersData.helpers.map((helper) => helper.first_name).join(", ")
        : "No helpers found.";
      await bot.sendMessage(chatId, helpersMessage);
    }

    if (sanitizedText === "/leavehelpers" || sanitizedText === "/leavehelpers@tagallesisbabot") {
      const helpersData = await getHelpers(chatId);
      const userIndex = helpersData.helpers.findIndex(
        (helper) => helper.id === userId
      );

      if (userIndex !== -1) {
        helpersData.helpers.splice(userIndex, 1);
        await updateHelpers(chatId, helpersData.helpers);
        await bot.sendMessage(chatId, "You have left the helpers!");
      } else {
        await bot.sendMessage(chatId, "You are not a helper!");
      }
    }

    if (sanitizedText === "/help" || sanitizedText === "/help@tagallesisbabot") {
      const helpersData = await getHelpers(chatId);
      const mentions = helpersData.helpers.map(
        (helper) => `[${helper.first_name}](tg://user?id=${helper.id})`
      );
      const message = mentions.length
        ? mentions.join(" ")
        : "No helpers available right now.";
      await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    }

    if (sanitizedText === "/reminders" || sanitizedText === "/reminders@tagallesisbabot") {
      const remindersData = await getReminders(chatId);
      const remindersMessage = remindersData.reminders.length
        ? remindersData.reminders
            .map(
              (reminder, index) =>
                `${index + 1}. ${reminder.text} - ${new Date(
                  reminder.date
                ).toLocaleDateString("fr-dz", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}`
            )
            .join("\n")
        : "No reminders found.";
      await bot.sendMessage(chatId, remindersMessage);
    }

    if (
      sanitizedText === "/clearreminders" ||
      sanitizedText === "/clearreminders@tagallesisbabot"
    ) {
      await updateReminders(chatId, []);
      await bot.sendMessage(chatId, "Reminders cleared");
    }

    // AI Commands
    if (sanitizedText === "/clearai" || sanitizedText === "/clearai@tagallesisbabot") {
      const collection = dbManager.getCollection("aiConversations");
      await collection.deleteOne({ chatId, userId });
      await bot.sendMessage(chatId, "🤖 AI conversation history cleared!");
    }

    if (sanitizedText === "/translate" || sanitizedText === "/translate@tagallesisbabot") {
      if (msg.reply_to_message && msg.reply_to_message.text) {
        await bot.sendChatAction(chatId, "typing");
        const translation = await translateText(msg.reply_to_message.text);
        await bot.sendMessage(chatId, `🌐 Translation:\n${translation}`);
      } else {
        await bot.sendMessage(
          chatId,
          "Please reply to a message to translate it."
        );
      }
    }

    if (sanitizedText === "/summarize" || sanitizedText === "/summarize@tagallesisbabot") {
      if (msg.reply_to_message && msg.reply_to_message.text) {
        await bot.sendChatAction(chatId, "typing");
        const summary = await summarizeText(msg.reply_to_message.text);
        await bot.sendMessage(chatId, `📝 Summary:\n${summary}`);
      } else {
        await bot.sendMessage(
          chatId,
          "Please reply to a message to summarize it."
        );
      }
    }

    if (sanitizedText === "/reset" || sanitizedText === "/reset@tagallesisbabot") {
      await updateGroupMembers(chatId, []);
      await updateHelpers(chatId, []);
      await updateReminders(chatId, []);
      const collection = dbManager.getCollection("aiConversations");
      await collection.deleteMany({ chatId });
      await bot.sendMessage(
        chatId,
        "Bot has been completely reset (including AI conversations)."
      );
    }

    // Enhanced credits command
    if (sanitizedText === "/credits" || sanitizedText === "/credits@tagallesisbabot") {
      try {
        await bot.sendChatAction(chatId, "typing");

        const [apiStatus, todayUsage] = await Promise.all([
          checkGeminiAPIStatus(),
          getAPIUsage(),
        ]);

        const creditsMessage = `
📊 **API Usage Information**

🔑 **API Status**: ${apiStatus.status === "active" ? "✅ Active" : "❌ Error"}
🤖 **Available Models**: ${apiStatus.models}
📈 **Today's Requests**: ${todayUsage}

📋 **Free Tier Limits** (Gemini):
• 15 requests per minute
• 1,500 requests per day
• 1 million tokens per day

💡 **Performance Features**:
• Rate limiting: ${CONFIG.RATE_LIMIT.max} requests per minute
• Caching enabled for faster responses
• Automatic retry on failures

⚠️ **Important**: Check Google AI Studio Console for accurate quota info.
Visit: https://aistudio.google.com/

${apiStatus.message}
        `;

        await bot.sendMessage(chatId, creditsMessage, { parse_mode: "Markdown" });
      } catch (error) {
        console.error("Credits command error:", error);
        await bot.sendMessage(chatId, "❌ Unable to fetch API information right now.");
      }
    }
  } catch (error) {
    console.error("Error in staticCommands:", error);
    await bot.sendMessage(chatId, "❌ An error occurred while processing your command.");
  }
}

// Enhanced main handler with better error handling
export default async function handler(event) {
  try {
    await dbManager.connect();

    const bodyString = await readStream(event.body);
    const body = JSON.parse(bodyString);

    const msg = body.message;
    if (!msg || !msg.text) {
      return new Response(
        JSON.stringify({ message: "No message or text to process" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = sanitizeInput(msg.text);

    // Handle static commands first
    await staticCommands(text, chatId, userId, msg);

    // AI Ask Command with enhanced error handling
    if (text.startsWith("/ask ") || text.startsWith("/ask@tagallesisbabot ")) {
      const question = text.replace(/^\/ask(@tagallesisbabot)?\s+/, "");
      if (question.trim()) {
        // Check message length before processing - now more generous
        if (question.length > CONFIG.MAX_PROMPT_LENGTH) {
          await bot.sendMessage(chatId, "❌ Your question is too long. Please keep it under 30,000 characters.");
          return new Response(JSON.stringify({ message: "Question too long" }), { status: 200 });
        }

        if (!checkRateLimit(userId)) {
          await bot.sendMessage(chatId, "⚠️ Rate limit exceeded. Please wait a moment before asking another question.");
          return new Response(JSON.stringify({ message: "Rate limited" }), { status: 200 });
        }

        await bot.sendChatAction(chatId, "typing");
        const aiResponse = await generateAIResponse(question, chatId, userId);
        await bot.sendMessage(chatId, `🤖 ${aiResponse}`);
      } else {
        await bot.sendMessage(
          chatId,
          "Please ask a question after /ask. Example: /ask What is the weather like?"
        );
      }
    }

    // Enhanced smart AI responses
    if (
      !text.startsWith("/") &&
      (text.includes("?") ||
        text.toLowerCase().includes("bot") ||
        text.includes("@tagallesisbabot") ||
        msg.reply_to_message?.from?.username === "tagallesisbabot")
    ) {
      // Check message length before processing - now more generous
      if (text.length > CONFIG.MAX_PROMPT_LENGTH) {
        await bot.sendMessage(chatId, "❌ Your message is too long. Please keep it under 30,000 characters.");
        return new Response(JSON.stringify({ message: "Message too long" }), { status: 200 });
      }

      if (!checkRateLimit(userId)) {
        return new Response(JSON.stringify({ message: "Rate limited" }), { status: 200 });
      }

      await bot.sendChatAction(chatId, "typing");
      const aiResponse = await generateAIResponse(text, chatId, userId);
      await bot.sendMessage(chatId, `🤖 ${aiResponse}`);
    }

    // Reminder system (existing)
    if (new Date().getHours() === 15 && new Date().getMinutes() === 33) {
      const remindersData = await getReminders(chatId);
      const remindersMessage = remindersData.reminders.length
        ? remindersData.reminders
            .map(
              (reminder, index) =>
                `${index + 1}. ${reminder.text} - ${new Date(
                  reminder.date
                ).toLocaleDateString("fr-dz", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}`
            )
            .join("\n")
        : "No reminders found.";

      await bot.sendMessage(chatId, remindersMessage);

      const currentDate = new Date();
      const updatedReminders = remindersData.reminders.filter(
        (reminder) => new Date(reminder.date) > currentDate
      );

      await updateReminders(chatId, updatedReminders);
    }

    // Clear reminder by index
    if (
      text.startsWith("/clearreminder") ||
      text.startsWith("/clearreminder@tagallesisbabot")
    ) {
      const remindersData = await getReminders(chatId);
      const index = parseInt(text.split(" ")[1]);

      if (isNaN(index) || index < 1 || index > remindersData.reminders.length) {
        await bot.sendMessage(chatId, "Invalid reminder index");
      } else if (remindersData.reminders.length === 0) {
        await bot.sendMessage(chatId, "No reminders found");
      } else if (!index) {
        await bot.sendMessage(
          chatId,
          "Please provide a reminder index to clear"
        );
      } else {
        remindersData.reminders.splice(index - 1, 1);
        await updateReminders(chatId, remindersData.reminders);
        await bot.sendMessage(chatId, `Reminder at index ${index} cleared`);
      }
    }

    // Set reminder
    if (
      text.startsWith("/setreminder") ||
      text.startsWith("/setreminder@tagallesisbabot")
    ) {
      try {
        const remindersData = await getReminders(chatId);
        const date = text.split(" ")[1];
        const messageText = msg.reply_to_message?.text;

        if (
          remindersData.reminders.some(
            (reminder) =>
              reminder.date === date && reminder.text === messageText
          )
        ) {
          await bot.sendMessage(
            chatId,
            "Reminder already set for the message at the same date"
          );
        } else if (!messageText) {
          await bot.sendMessage(
            chatId,
            "Please reply to a message to set a reminder"
          );
        } else if (!date) {
          await bot.sendMessage(
            chatId,
            "Please provide a date for the reminder with the format /setreminder <yyyy-mm-dd>"
          );
        } else if (!isValidDate(date)) {
          await bot.sendMessage(
            chatId,
            "Invalid date, please provide a valid date in the format yyyy-mm-dd"
          );
        } else {
          remindersData.reminders.push({ date, text: messageText });
          await updateReminders(chatId, remindersData.reminders);
          await bot.sendMessage(chatId, `Reminder set for ${date}`);
        }
      } catch (error) {
        await bot.sendMessage(chatId, error.message);
      }
    }

    return new Response(
      JSON.stringify({ message: "Message processed successfully" }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Handler Error:", error);

    // Graceful error response
    const errorMessage = error instanceof BotError
      ? error.message
      : "Internal Server Error";

    return new Response(
      JSON.stringify({
        message: errorMessage,
        error: process.env.NODE_ENV === "development" ? error.message : undefined,
      }),
      {
        status: error instanceof BotError ? error.statusCode : 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing database connection...");
  await dbManager.disconnect();
  process.exit(0);
});
