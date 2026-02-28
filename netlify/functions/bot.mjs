//bot.mjs
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

// affichage bot part:

// ============================================
// PROGRES API GRADE CHECKING SYSTEM
// ============================================

// Progres API helper functions
async function loginToProgres() {
  try {
    const response = await fetch(
      "https://progres.mesrs.dz/api/authentication/v1/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: process.env.PROGRES_USERNAME,
          password: process.env.PROGRES_PASSWORD,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Login failed: ${response.status}`);
    }

    const data = await response.json();

    // Extract the last (most recent) card ID from dias
    const cardIds = data.dias.split(",").map((id) => id.trim());
    const cardId = cardIds[cardIds.length - 1];

    return {
      token: data.token,
      cardId: cardId,
      expirationDate: data.expirationDate,
    };
  } catch (error) {
    console.error("Progres login error:", error);
    throw error;
  }
}

async function fetchExamGrades(cardId, token) {
  try {
    const response = await fetch(
      `https://progres.mesrs.dz/api/infos/planningSession/dia/${cardId}/noteExamens`,
      {
        method: "GET",
        headers: {
          Authorization: token,
        },
      },
    );

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("AUTH_ERROR");
      }
      throw new Error(`Fetch exam grades failed: ${response.status}`);
    }

    const data = await response.json();

    // Extract only needed fields: id, mcLibelleFr, noteExamen
    return data.map((grade) => ({
      id: grade.id,
      moduleName: grade.mcLibelleFr,
      grade: grade.noteExamen,
    }));
  } catch (error) {
    console.error("Fetch exam grades error:", error);
    throw error;
  }
}

async function fetchCCGrades(cardId, token) {
  try {
    const response = await fetch(
      `https://progres.mesrs.dz/api/infos/controleContinue/dia/${cardId}/notesCC`,
      {
        method: "GET",
        headers: {
          Authorization: token,
        },
      },
    );

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("AUTH_ERROR");
      }
      throw new Error(`Fetch CC grades failed: ${response.status}`);
    }

    const data = await response.json();

    // Extract only needed fields: id, rattachementMcMcLibelleFr, note
    return data.map((grade) => ({
      id: grade.id,
      moduleName: grade.rattachementMcMcLibelleFr,
      grade: grade.note,
    }));
  } catch (error) {
    console.error("Fetch CC grades error:", error);
    throw error;
  }
}

// Database functions for grades
async function getStoredGrades() {
  const cacheKey = getCacheKey("grades");
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const collection = dbManager.getCollection("grades");
  const gradesData = await collection.findOne({});
  const result = gradesData || {
    cardId: null,
    token: null,
    tokenExpiry: null,
    examGrades: [],
    ccGrades: [],
    lastChecked: null,
  };

  setCache(cacheKey, result);
  return result;
}

async function updateStoredGrades(gradesData) {
  const collection = dbManager.getCollection("grades");
  await collection.updateOne(
    {},
    {
      $set: {
        ...gradesData,
        lastUpdated: new Date(),
      },
    },
    { upsert: true },
  );

  // Invalidate cache
  const cacheKey = getCacheKey("grades");
  cache.delete(cacheKey);
}

// Main grade checking function
async function checkGradesAndNotify() {
  try {
    console.log("Starting grade check at:", new Date().toISOString());

    // Get stored data
    let storedData = await getStoredGrades();
    let { token, cardId, tokenExpiry } = storedData;

    // Check if we need to login (first time or token expired)
    const needsLogin = !token || !cardId || new Date(tokenExpiry) <= new Date();

    if (needsLogin) {
      console.log("Logging in to Progres...");
      const loginData = await loginToProgres();
      token = loginData.token;
      cardId = loginData.cardId;
      tokenExpiry = loginData.expirationDate;

      // Update stored data with new token
      storedData.token = token;
      storedData.cardId = cardId;
      storedData.tokenExpiry = tokenExpiry;
    }

    // Fetch current grades
    let examGrades, ccGrades;
    try {
      [examGrades, ccGrades] = await Promise.all([
        fetchExamGrades(cardId, token),
        fetchCCGrades(cardId, token),
      ]);
    } catch (error) {
      if (error.message === "AUTH_ERROR") {
        // Token expired, re-login and retry
        console.log("Token expired, re-logging in...");
        const loginData = await loginToProgres();
        token = loginData.token;
        cardId = loginData.cardId;
        tokenExpiry = loginData.expirationDate;

        // Retry fetching grades
        [examGrades, ccGrades] = await Promise.all([
          fetchExamGrades(cardId, token),
          fetchCCGrades(cardId, token),
        ]);

        // Update token in storage
        storedData.token = token;
        storedData.cardId = cardId;
        storedData.tokenExpiry = tokenExpiry;
      } else {
        throw error;
      }
    }

    // Compare with stored grades and detect changes
    const changes = [];

    // Check exam grades
    for (const newGrade of examGrades) {
      const oldGrade = storedData.examGrades.find((g) => g.id === newGrade.id);

      // Detect change: null -> number
      if (oldGrade) {
        if (oldGrade.grade === null && newGrade.grade !== null) {
          changes.push({
            type: "exam",
            moduleName: newGrade.moduleName,
            oldGrade: oldGrade.grade,
            newGrade: newGrade.grade,
          });
        }
      } else if (newGrade.grade !== null) {
        // New grade entry with non-null value
        changes.push({
          type: "exam",
          moduleName: newGrade.moduleName,
          oldGrade: null,
          newGrade: newGrade.grade,
        });
      }
    }

    // Check CC grades
    for (const newGrade of ccGrades) {
      const oldGrade = storedData.ccGrades.find((g) => g.id === newGrade.id);

      // Detect change: null -> number
      if (oldGrade) {
        if (oldGrade.grade === null && newGrade.grade !== null) {
          changes.push({
            type: "cc",
            moduleName: newGrade.moduleName,
            oldGrade: oldGrade.grade,
            newGrade: newGrade.grade,
          });
        }
      } else if (newGrade.grade !== null) {
        // New grade entry with non-null value
        changes.push({
          type: "cc",
          moduleName: newGrade.moduleName,
          oldGrade: null,
          newGrade: newGrade.grade,
        });
      }
    }

    console.log(`Found ${changes.length} grade changes`);

    // Send notifications for changes
    if (changes.length > 0 && process.env.CLASS_GROUP_ID) {
      const groupId = process.env.CLASS_GROUP_ID;

      for (const change of changes) {
        const prefix = change.type === "cc" ? "NOTE TD/TP" : "EXAMEN";
        const message = `AFFICHAGE ${prefix} ${change.moduleName} PROGRES!`;
        try {
          await bot.sendMessage(groupId, message);
          console.log(`Sent notification for: ${change.moduleName}`);
        } catch (error) {
          console.error(
            `Failed to send notification for ${change.moduleName}:`,
            error.message,
          );
        }
      }
    }

    // Update stored grades with new data
    storedData.examGrades = examGrades;
    storedData.ccGrades = ccGrades;
    storedData.lastChecked = new Date().toISOString();
    await updateStoredGrades(storedData);

    return {
      success: true,
      changesFound: changes.length,
      changes: changes,
      lastChecked: storedData.lastChecked,
    };
  } catch (error) {
    console.error("Error in checkGradesAndNotify:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

dotenv.config();

const bot = new TelegramBot(process.env.TOKEN);

// Configuration
const CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY: 1000,
  CACHE_TTL: 5 * 60 * 1000, // 5 minutes
  MAX_CONVERSATION_HISTORY: 20,
  MAX_MESSAGE_LENGTH: 4000,
  MAX_PROMPT_LENGTH: 30000,
  MAX_CONTEXT_LENGTH: 25000,
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
      await this.db
        .collection("aiConversations")
        .createIndex({ chatId: 1, userId: 1 });
      await this.db
        .collection("apiUsage")
        .createIndex({ date: 1 }, { expireAfterSeconds: 86400 });
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
    userRateLimit.set(userKey, {
      requests: 1,
      resetTime: now + CONFIG.RATE_LIMIT.window,
    });
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
      { upsert: true },
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
      throw new BotError(
        "GEMINI_API_KEY not found in environment variables",
        "MISSING_API_KEY",
        500,
      );
    }

    // UPDATED: Gemini 2.5 Flash
    const model = "gemini-2.5-flash";
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
            maxOutputTokens: 2048,
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
      },
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Gemini API Error:", errorData);

      if (
        response.status === 429 ||
        errorData.error?.message?.includes("quota")
      ) {
        throw new BotError("QUOTA_EXCEEDED", "QUOTA_EXCEEDED", 429);
      }

      // Retry on server errors
      if (response.status >= 500 && retries > 0) {
        console.log(`Retrying API call... ${retries} attempts left`);
        await new Promise((resolve) => setTimeout(resolve, CONFIG.RETRY_DELAY));
        return callGeminiAPI(prompt, retries - 1);
      }

      throw new BotError(
        `Gemini API error: ${response.status} - ${
          errorData.error?.message || "Unknown error"
        }`,
        "API_ERROR",
        response.status,
      );
    }

    const data = await response.json();

    if (!data.candidates || data.candidates.length === 0) {
      throw new BotError(
        "No response generated from Gemini API",
        "NO_RESPONSE",
        500,
      );
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

    throw new BotError(
      "Network error connecting to Gemini API",
      "NETWORK_ERROR",
      500,
    );
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
    { upsert: true },
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
    { upsert: true },
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
    { upsert: true },
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
    { upsert: true },
  );
}

async function generateAIResponse(prompt, chatId, userId, replyContext = null) {
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
    let fullPrompt = `You are a helpful assistant in a Telegram university group chat (Algerian students). Be concise and direct — just answer the question. Do NOT add labels like "Answer:", "AI:", section headers, or meta-commentary. Use markdown only when it genuinely helps (bold for key terms, code blocks for code, bullet lists for steps). Keep it natural and friendly. You're knowledgeable in academics but can chat casually and have fun too.

`;

    if (history.length > 0) {
      fullPrompt += "Previous conversation:\n";
      // Dynamically adjust history based on available space
      const basePromptLength = fullPrompt.length + sanitizedPrompt.length + 50; // Buffer
      const availableSpace = CONFIG.MAX_CONTEXT_LENGTH - basePromptLength;

      if (availableSpace > 500) {
        let historyText = "";
        const recentHistory = history.slice(-15);

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

    if (replyContext) {
      fullPrompt += `[Context — the user is replying to this message: "${sanitizeInput(replyContext).substring(0, 500)}"]
`;
    }
    fullPrompt += sanitizedPrompt;

    // Final check for prompt length with more generous limits
    if (fullPrompt.length > CONFIG.MAX_CONTEXT_LENGTH) {
      // Smart truncation: keep the most recent context
      const basePrompt = `You are a helpful assistant in a Telegram university group chat. Be concise and direct — just answer, no labels or headers. Markdown only when it helps.`;
      const userPrompt = replyContext
        ? `[Replying to: "${sanitizeInput(replyContext).substring(0, 200)}"]
${sanitizedPrompt}`
        : sanitizedPrompt;
      const availableForHistory =
        CONFIG.MAX_CONTEXT_LENGTH - basePrompt.length - userPrompt.length - 100;

      if (availableForHistory > 200 && history.length > 0) {
        let contextHistory = "Recent conversation:\n";
        const recentHistory = history.slice(-10);

        for (let i = recentHistory.length - 1; i >= 0; i--) {
          const msg = recentHistory[i];
          const msgText = `${msg.role}: ${msg.content.substring(0, 500)}\n`;

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
          return "⚠️ **API quota exceeded!** You've reached your free tier limit. Please try again tomorrow or upgrade your plan.";
        case "RATE_LIMIT":
          return "⚠️ **Too many requests. ** Please wait a moment before trying again.";
        case "INVALID_PROMPT":
          return "❌ **Invalid input provided.** Please check your message and try again.";
        case "PROMPT_TOO_LONG":
          return "❌ **Your message is too long. ** Please keep it under 30,000 characters.";
        default:
          return "😔 Sorry, I'm having trouble processing your request right now. ";
      }
    }

    return "😔 Sorry, I'm having trouble processing your request right now.";
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

// UPDATED: Enhanced translateText with target language parameter
async function translateText(text, targetLanguage = null) {
  const sanitized = sanitizeInput(text);

  // Handle very long texts by chunking if needed
  if (sanitized.length > 20000) {
    const chunks = [];
    for (let i = 0; i < sanitized.length; i += 20000) {
      chunks.push(sanitized.substring(i, i + 20000));
    }

    const translations = [];
    for (const chunk of chunks) {
      let prompt;
      if (targetLanguage) {
        prompt = `You are a Telegram bot translator. Auto-detect the language of the following text and translate it to ${targetLanguage}. 

**Important formatting rules:**
- Preserve any Telegram formatting (bold, italic, code blocks)
- Only provide the translation, nothing else
- Keep the same structure and formatting

Text to translate:
${chunk}`;
      } else {
        prompt = `You are a Telegram bot translator.  Translate the following text to English.  If it's already in English, translate to Arabic. 

**Important formatting rules:**
- Preserve any Telegram formatting (bold, italic, code blocks)
- Only provide the translation, nothing else
- Keep the same structure and formatting

Text to translate:
${chunk}`;
      }
      const translation = await callGeminiAPI(prompt);
      translations.push(translation);
    }

    return translations.join(" ");
  }

  let prompt;
  if (targetLanguage) {
    prompt = `You are a Telegram bot translator. Auto-detect the language of the following text and translate it to ${targetLanguage}.

**Important formatting rules:**
- Preserve any Telegram formatting (**bold**, *italic*, \`code\`)
- Only provide the translation, nothing else
- Keep the same structure and formatting

Text to translate:
${sanitized}`;
  } else {
    prompt = `You are a Telegram bot translator. Translate the following text to English. If it's already in English, translate to Arabic. 

**Important formatting rules:**
- Preserve any Telegram formatting (**bold**, *italic*, \`code\`)
- Only provide the translation, nothing else
- Keep the same structure and formatting

Text to translate:
${sanitized}`;
  }

  return await callGeminiAPI(prompt);
}

async function summarizeText(text) {
  const sanitized = sanitizeInput(text);

  // Handle very long texts with more detailed summarization instructions
  if (sanitized.length > 20000) {
    const prompt = `You are a Telegram bot summarizer.  Provide a comprehensive summary of the following long text. 

**Formatting requirements:**
- Use **bold** for main points
- Use *italic* for supporting details
- Use bullet points with • for lists
- Add relevant emojis 📝
- Structure the summary clearly

Text to summarize:
${sanitized}`;
    return await callGeminiAPI(prompt);
  }

  const prompt = `You are a Telegram bot summarizer. Summarize the following text concisely.

**Formatting requirements:**
- Use **bold** for key points
- Use *italic* for details
- Add relevant emojis 📋
- Keep it well-structured and readable

Text to summarize:
${sanitized}`;
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
        signal: AbortSignal.timeout(10000),
      },
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
    description: "Clear reminders by index (comma-separated)",
  },
  // AI Commands
  { command: "ask", description: "Ask AI a question" },
  {
    command: "translate",
    description:
      "Translate text (reply to message, optionally: /translate to {language})",
  },
  { command: "summarize", description: "Summarize text (reply to message)" },
  { command: "clearai", description: "Clear AI conversation history" },
  { command: "credits", description: "Check API usage information" },
  { command: "check", description: "Check for new grades from Progres" },
  { command: "games", description: "Play group games together 🎮" },
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

    if (
      sanitizedText === "/start" ||
      sanitizedText === "/start@tagallesisbabot"
    ) {
      await bot.sendMessage(
        chatId,
        "👋 **Hello! ** I'm your AI-powered group assistant.\n\n🔹 Use `/join` to join the group\n🔹 Use `/ask` to chat with me\n🔹 Use `/help` to see all commands\n\n*Let's get started!* 🚀",
        { parse_mode: "Markdown" },
      );
    }

    if (
      sanitizedText === "/join" ||
      sanitizedText === "/join@tagallesisbabot"
    ) {
      const groupData = await getGroupMembers(chatId);
      const user = { id: userId, first_name: msg.from.first_name };

      if (!groupData.members.some((member) => member.id === userId)) {
        groupData.members.push(user);
        await updateGroupMembers(chatId, groupData.members);
        await bot.sendMessage(
          chatId,
          `✅ **Welcome aboard!** You have successfully joined the group, *${user.first_name}*! 🎉`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot.sendMessage(
          chatId,
          `ℹ️ **Already a member! ** You're already part of our group, *${user.first_name}*!  😊`,
          { parse_mode: "Markdown" },
        );
      }
    }

    if (
      sanitizedText === "/leave" ||
      sanitizedText === "/leave@tagallesisbabot"
    ) {
      const groupData = await getGroupMembers(chatId);
      const userIndex = groupData.members.findIndex(
        (member) => member.id === userId,
      );

      if (userIndex !== -1) {
        const userName = groupData.members[userIndex].first_name;
        groupData.members.splice(userIndex, 1);
        await updateGroupMembers(chatId, groupData.members);
        await bot.sendMessage(
          chatId,
          `👋 **Goodbye!** *${userName}* has left the group. We'll miss you! 😢`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot.sendMessage(
          chatId,
          "❌ **Not a member!** You weren't part of the group to begin with. 🤔",
          { parse_mode: "Markdown" },
        );
      }
    }

    if (
      sanitizedText === "/showmembers" ||
      sanitizedText === "/showmembers@tagallesisbabot"
    ) {
      const groupData = await getGroupMembers(chatId);
      if (groupData.members.length > 0) {
        const membersList = groupData.members
          .map((member, index) => `${index + 1}. *${member.first_name}*`)
          .join("\n");
        await bot.sendMessage(
          chatId,
          `👥 **Group Members** (${groupData.members.length})\n\n${membersList}`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot.sendMessage(
          chatId,
          "📭 **No members found.** The group is currently empty.",
          { parse_mode: "Markdown" },
        );
      }
    }

    if (
      sanitizedText === "/mentionall" ||
      sanitizedText === "/mentionall@tagallesisbabot"
    ) {
      const groupData = await getGroupMembers(chatId);
      const mentions = groupData.members.map(
        (member) => `[${member.first_name}](tg://user?id=${member.id})`,
      );

      const message = mentions.length
        ? `🔔 **Attention everyone!**\n\n${mentions.join(
            " ",
          )}\n\n*You've been summoned! * ⚡`
        : "📭 **No members to mention.** The group is currently empty. ";
      await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    }

    if (
      sanitizedText === "/addtohelp" ||
      sanitizedText === "/addtohelp@tagallesisbabot"
    ) {
      const helpersData = await getHelpers(chatId);
      const helper = { id: userId, first_name: msg.from.first_name };

      if (!helpersData.helpers.some((h) => h.id === userId)) {
        helpersData.helpers.push(helper);
        await updateHelpers(chatId, helpersData.helpers);
        await bot.sendMessage(
          chatId,
          `🆘 **New Helper!** *${helper.first_name}* has joined the helpers team! 🙋‍♂️`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot.sendMessage(
          chatId,
          `ℹ️ **Already helping!** You're already part of our helpers team, *${helper.first_name}*! 👨‍🔧`,
          { parse_mode: "Markdown" },
        );
      }
    }

    if (
      sanitizedText === "/showhelpers" ||
      sanitizedText === "/showhelpers@tagallesisbabot"
    ) {
      const helpersData = await getHelpers(chatId);
      if (helpersData.helpers.length > 0) {
        const helpersList = helpersData.helpers
          .map((helper, index) => `${index + 1}. *${helper.first_name}* 🆘`)
          .join("\n");
        await bot.sendMessage(
          chatId,
          `🆘 **Available Helpers** (${helpersData.helpers.length})\n\n${helpersList}\n\n*These members are ready to help!*`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot.sendMessage(
          chatId,
          "📭 **No helpers found.** No one is currently available to help.",
          { parse_mode: "Markdown" },
        );
      }
    }

    if (
      sanitizedText === "/leavehelpers" ||
      sanitizedText === "/leavehelpers@tagallesisbabot"
    ) {
      const helpersData = await getHelpers(chatId);
      const userIndex = helpersData.helpers.findIndex(
        (helper) => helper.id === userId,
      );

      if (userIndex !== -1) {
        const helperName = helpersData.helpers[userIndex].first_name;
        helpersData.helpers.splice(userIndex, 1);
        await updateHelpers(chatId, helpersData.helpers);
        await bot.sendMessage(
          chatId,
          `👋 **Helper departure!** *${helperName}* has left the helpers team.  Thanks for your service! 🙏`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot.sendMessage(
          chatId,
          "❌ **Not a helper!** You weren't part of the helpers team.  🤷‍♂️",
          { parse_mode: "Markdown" },
        );
      }
    }

    if (
      sanitizedText === "/help" ||
      sanitizedText === "/help@tagallesisbabot"
    ) {
      const helpersData = await getHelpers(chatId);
      const mentions = helpersData.helpers.map(
        (helper) => `[${helper.first_name}](tg://user?id=${helper.id})`,
      );
      const message = mentions.length
        ? `🆘 **Help requested!**\n\n${mentions.join(
            " ",
          )}\n\n*Someone needs assistance!* 🚨`
        : "📭 **No helpers available right now.** Try again later or ask in the group!  🤝";
      await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    }

    if (
      sanitizedText === "/reminders" ||
      sanitizedText === "/reminders@tagallesisbabot"
    ) {
      const remindersData = await getReminders(chatId);
      if (remindersData.reminders.length > 0) {
        const remindersList = remindersData.reminders
          .map(
            (reminder, index) =>
              `${index + 1}.  **${reminder.text}**\n   📅 *${new Date(
                reminder.date,
              ).toLocaleDateString("en-US", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric",
              })}*`,
          )
          .join("\n\n");
        await bot.sendMessage(
          chatId,
          `⏰ **Active Reminders** (${remindersData.reminders.length})\n\n${remindersList}`,
          { parse_mode: "Markdown" },
        );
      } else {
        await bot.sendMessage(
          chatId,
          "📭 **No reminders found.** You haven't set any reminders yet.",
          { parse_mode: "Markdown" },
        );
      }
    }

    if (
      sanitizedText === "/clearreminders" ||
      sanitizedText === "/clearreminders@tagallesisbabot"
    ) {
      await updateReminders(chatId, []);
      await bot.sendMessage(
        chatId,
        "🗑️ **Reminders cleared!** All reminders have been deleted. ✨",
        { parse_mode: "Markdown" },
      );
    }

    // AI Commands
    if (
      sanitizedText === "/clearai" ||
      sanitizedText === "/clearai@tagallesisbabot"
    ) {
      const collection = dbManager.getCollection("aiConversations");
      await collection.deleteOne({ chatId, userId });
      await bot.sendMessage(
        chatId,
        "🤖 **AI memory cleared!** Our conversation history has been reset. Starting fresh! 🔄",
        { parse_mode: "Markdown" },
      );
    }

    // UPDATED: Enhanced /translate command with target language support
    if (
      sanitizedText.startsWith("/translate") ||
      sanitizedText.startsWith("/translate@tagallesisbabot")
    ) {
      if (msg.reply_to_message && msg.reply_to_message.text) {
        await bot.sendChatAction(chatId, "typing");

        // Parse target language from command: /translate to {language}
        const translateMatch = sanitizedText.match(
          /^\/translate(?:@tagallesisbabot)?\s+to\s+(.+)$/i,
        );
        const targetLanguage = translateMatch ? translateMatch[1].trim() : null;

        const translation = await translateText(
          msg.reply_to_message.text,
          targetLanguage,
        );

        const langInfo = targetLanguage
          ? `🌐 **Translation to ${targetLanguage}:**`
          : "🌐 **Translation:**";

        await bot.sendMessage(chatId, `${langInfo}\n\n${translation}`, {
          parse_mode: "Markdown",
        });
      } else {
        await bot.sendMessage(
          chatId,
          "❓ **How to translate:**\n\nReply to a message with:\n• `/translate` — auto English ↔ Arabic\n• `/translate to french` — translate to French\n• `/translate to spanish` — translate to Spanish\n• `/translate to {any language}` 🔄",
          { parse_mode: "Markdown" },
        );
      }
    }

    if (
      sanitizedText === "/summarize" ||
      sanitizedText === "/summarize@tagallesisbabot"
    ) {
      if (msg.reply_to_message && msg.reply_to_message.text) {
        await bot.sendChatAction(chatId, "typing");
        const summary = await summarizeText(msg.reply_to_message.text);
        await bot.sendMessage(chatId, `📝 **Summary:**\n\n${summary}`, {
          parse_mode: "Markdown",
        });
      } else {
        await bot.sendMessage(
          chatId,
          "❓ **How to summarize:** Reply to a message with `/summarize` to get a summary!  📋",
          { parse_mode: "Markdown" },
        );
      }
    }

    if (
      sanitizedText === "/reset" ||
      sanitizedText === "/reset@tagallesisbabot"
    ) {
      await updateGroupMembers(chatId, []);
      await updateHelpers(chatId, []);
      await updateReminders(chatId, []);
      const collection = dbManager.getCollection("aiConversations");
      await collection.deleteMany({ chatId });
      await bot.sendMessage(
        chatId,
        "🔄 **Complete Reset!**\n\n✅ All members cleared\n✅ All helpers cleared\n✅ All reminders cleared\n✅ AI conversations cleared\n\n*Starting fresh!* 🚀",
        { parse_mode: "Markdown" },
      );
    }

    // Enhanced credits command
    if (
      sanitizedText === "/credits" ||
      sanitizedText === "/credits@tagallesisbabot"
    ) {
      try {
        await bot.sendChatAction(chatId, "typing");

        const [apiStatus, todayUsage] = await Promise.all([
          checkGeminiAPIStatus(),
          getAPIUsage(),
        ]);

        const creditsMessage = `
📊 **API Usage Information**

🔑 **API Status**: ${apiStatus.status === "active" ? "✅ Active" : "❌ Error"}
🤖 **Model**: \`gemini-2.5-flash\`
📈 **Today's Requests**: \`${todayUsage}\`

📋 **Free Tier Limits** _(Gemini)_:
• \`15\` requests per minute
• \`1,500\` requests per day  
• \`1 million\` tokens per day

💡 **Performance Features**:
• **Rate limiting**: \`${CONFIG.RATE_LIMIT.max}\` requests per minute
• **Caching** enabled for faster responses ⚡
• **Automatic retry** on failures 🔄

⚠️ **Important**: Check Google AI Studio Console for accurate quota info.
🔗 **Visit**: https://aistudio.google.com/

📝 *${apiStatus.message}*
        `;

        await bot.sendMessage(chatId, creditsMessage, {
          parse_mode: "Markdown",
        });
      } catch (error) {
        console.error("Credits command error:", error);
        await bot.sendMessage(
          chatId,
          "❌ **Error!** Unable to fetch API information right now. Please try again later. 🔄",
          { parse_mode: "Markdown" },
        );
      }
    }

    // Games command
    if (
      sanitizedText === "/games" ||
      sanitizedText === "/games@tagallesisbabot"
    ) {
      await bot.sendMessage(
        chatId,
        "🎮 *Choose a game for the group!*\n\nTap a button and the bot will generate a prompt for everyone to play:",
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🎭 Truth", callback_data: "game_truth" },
                { text: "😈 Dare", callback_data: "game_dare" },
              ],
              [
                { text: "🤔 Would You Rather", callback_data: "game_wyr" },
                { text: "🧠 Trivia", callback_data: "game_trivia" },
              ],
              [
                { text: "🔥 Hot Take", callback_data: "game_hottake" },
                { text: "🧩 Riddle", callback_data: "game_riddle" },
              ],
              [
                { text: "📖 Story Builder", callback_data: "game_story" },
                {
                  text: "✏️ Finish the Sentence",
                  callback_data: "game_finish",
                },
              ],
              [
                { text: "🔡 Acronym", callback_data: "game_acronym" },
                {
                  text: "😤 Unpopular Opinion",
                  callback_data: "game_unpopular",
                },
              ],
            ],
          },
        },
      );
    }

    // check affichage:
    if (
      sanitizedText === "/check" ||
      sanitizedText === "/check@tagallesisbabot"
    ) {
      try {
        await bot.sendMessage(
          chatId,
          "🔍 **Checking for new grades...**\n\nPlease wait, this may take a moment. ⏳",
          { parse_mode: "Markdown" },
        );

        await bot.sendChatAction(chatId, "typing");

        const result = await checkGradesAndNotify();

        if (result.success) {
          if (result.changesFound > 0) {
            await bot.sendMessage(
              chatId,
              `✅ **Grade check completed!**\n\n🎓 Found **${result.changesFound}** new grade(s)!\n\nNotifications sent to the class group. 📢`,
              { parse_mode: "Markdown" },
            );
          } else {
            await bot.sendMessage(
              chatId,
              `✅ **Grade check completed!**\n\n📋 No new grades found.\n\n*Last checked: ${new Date(new Date(result.lastChecked).getTime() + 3600000).toISOString().slice(0, 16).replace("T", " ")}*`,
              { parse_mode: "Markdown" },
            );
          }
        } else {
          await bot.sendMessage(
            chatId,
            `❌ **Error checking grades:**\n\n\`${result.error}\`\n\nPlease try again later. 🔄`,
            { parse_mode: "Markdown" },
          );
        }
      } catch (error) {
        console.error("Check command error:", error);
        await bot.sendMessage(
          chatId,
          "❌ **Error!** Failed to check grades. Please try again later. 🔧",
          { parse_mode: "Markdown" },
        );
      }
    }
  } catch (error) {
    console.error("Error in staticCommands:", error);
    await bot.sendMessage(
      chatId,
      "❌ **Oops!** An error occurred while processing your command. Please try again! 🔧",
      { parse_mode: "Markdown" },
    );
  }
}

// ============================================
// GAMES SYSTEM
// ============================================

const GAMES = {
  truth: {
    label: "🎭 Truth",
    prompt:
      "Generate one truth question for a university student group chat — fun, slightly personal but appropriate. Just the question, nothing else.",
  },
  dare: {
    label: "😈 Dare",
    prompt:
      "Generate one dare challenge for a university student group — silly or bold but appropriate. Just the dare, nothing else.",
  },
  wyr: {
    label: "🤔 Would You Rather",
    prompt:
      "Generate one 'Would You Rather' dilemma for a university group chat. Make both options genuinely hard to choose between. Format only as: 'Would you rather [A] or [B]?' — nothing else.",
  },
  trivia: {
    label: "🧠 Trivia",
    prompt:
      "Generate one fun trivia question with 4 options labeled A, B, C, D. On the last line write only: ||Answer: X|| where X is the correct letter. Nothing else.",
  },
  hottake: {
    label: "🔥 Hot Take",
    prompt:
      "Generate one spicy controversial opinion about university life or pop culture for group debate. Just the statement, nothing else. Make it genuinely divisive so people want to argue.",
  },
  riddle: {
    label: "🧩 Riddle",
    prompt:
      "Give one clever riddle suitable for a university group. On the last line write only: ||Answer: [answer]|| — nothing else after that.",
  },
  story: {
    label: "📖 Story Builder",
    prompt:
      "Start a collaborative story with exactly ONE sentence — make it intriguing, funny, or dramatic so people want to continue it. End with '...' to signal others should add to it. Nothing else.",
  },
  finish: {
    label: "✏️ Finish the Sentence",
    prompt:
      "Give one funny or thought-provoking incomplete sentence for a university group to finish. Example format: 'The professor walked in and suddenly...' — just the incomplete sentence, nothing else.",
  },
  acronym: {
    label: "🔡 Acronym",
    prompt:
      "Give one 4 or 5 letter acronym (capital letters only, no explanation) then on the next line say: 'Make a funny/creative sentence where each word starts with these letters!' — nothing else.",
  },
  unpopular: {
    label: "😤 Unpopular Opinion",
    prompt:
      "Give one genuinely unpopular opinion that most people would disagree with but is fun to debate in a group. Just the opinion as a statement, nothing else.",
  },
};

// Convert AI response to safe HTML, turning ||spoiler|| into Telegram spoiler tags
function formatGameMessage(text) {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\|\|(.+?)\|\|/gs, "<tg-spoiler>$1</tg-spoiler>");
}

async function handleGameCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const callbackId = callbackQuery.id;
  const data = callbackQuery.data;
  const callerName = callbackQuery.from.first_name || "Someone";

  try {
    await bot.answerCallbackQuery(callbackId);
  } catch (e) {
    // ignore answer timeout errors
  }

  if (!data.startsWith("game_")) return;
  const gameKey = data.replace("game_", "");
  const game = GAMES[gameKey];
  if (!game) return;

  try {
    await bot.sendChatAction(chatId, "typing");
    const content = await callGeminiAPI(game.prompt);
    const formatted = formatGameMessage(content);
    await bot.sendMessage(
      chatId,
      `<b>${game.label}</b> — picked by <b>${callerName}</b>\n\n${formatted}`,
      { parse_mode: "HTML" },
    );
  } catch (error) {
    console.error("Game callback error:", error);
    await bot.sendMessage(
      chatId,
      "❌ Failed to generate game content. Try again!",
    );
  }
}

// Enhanced main handler with better error handling
export default async function handler(event) {
  try {
    await dbManager.connect();

    const bodyString = await readStream(event.body);
    const body = JSON.parse(bodyString);

    // Handle inline keyboard callbacks (e.g. game buttons)
    const callbackQuery = body.callback_query;
    if (callbackQuery) {
      await handleGameCallback(callbackQuery);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const msg = body.message;
    if (!msg || !msg.text) {
      return new Response(
        JSON.stringify({ message: "No message or text to process" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
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
        // Check message length before processing
        if (question.length > CONFIG.MAX_PROMPT_LENGTH) {
          await bot.sendMessage(
            chatId,
            "❌ **Question too long!** Please keep it under 30,000 characters. 📏",
            { parse_mode: "Markdown" },
          );
          return new Response(
            JSON.stringify({ message: "Question too long" }),
            { status: 200 },
          );
        }

        if (!checkRateLimit(userId)) {
          await bot.sendMessage(
            chatId,
            "⚠️ **Rate limit exceeded!** Please wait a moment before asking another question. ⏳",
            { parse_mode: "Markdown" },
          );
          return new Response(JSON.stringify({ message: "Rate limited" }), {
            status: 200,
          });
        }

        await bot.sendChatAction(chatId, "typing");
        const replyContext = msg.reply_to_message?.text || null;
        const aiResponse = await generateAIResponse(
          question,
          chatId,
          userId,
          replyContext,
        );
        await bot.sendMessage(chatId, `🤖 ${aiResponse}`, {
          parse_mode: "Markdown",
        });
      } else {
        await bot.sendMessage(
          chatId,
          "❓ **How to ask:** Use `/ask` followed by your question!\n\n*Example:* `/ask What is the weather like?` 🌤️",
          { parse_mode: "Markdown" },
        );
      }
    }

    // Reminder system (existing)
    if (new Date().getHours() === 15 && new Date().getMinutes() === 33) {
      const remindersData = await getReminders(chatId);
      const remindersMessage = remindersData.reminders.length
        ? remindersData.reminders
            .map(
              (reminder, index) =>
                `${index + 1}. ${reminder.text} - ${new Date(
                  reminder.date,
                ).toLocaleDateString("fr-dz", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}`,
            )
            .join("\n")
        : "No reminders found.";

      await bot.sendMessage(chatId, remindersMessage);

      const currentDate = new Date();
      const updatedReminders = remindersData.reminders.filter(
        (reminder) => new Date(reminder.date) > currentDate,
      );

      await updateReminders(chatId, updatedReminders);
    }

    // UPDATED: Clear reminder by index - now supports multiple comma-separated indexes
    if (
      text.startsWith("/clearreminder") ||
      text.startsWith("/clearreminder@tagallesisbabot")
    ) {
      const remindersData = await getReminders(chatId);
      const indexPart = text.split(" ")[1];

      if (!indexPart) {
        await bot.sendMessage(
          chatId,
          "❓ **How to use:** `/clearreminder 1` or `/clearreminder 1,2,3,5`\n\nProvide one or more indexes separated by commas. 📋",
          { parse_mode: "Markdown" },
        );
      } else if (remindersData.reminders.length === 0) {
        await bot.sendMessage(
          chatId,
          "📭 **No reminders found.** There are no reminders to clear.",
          { parse_mode: "Markdown" },
        );
      } else {
        // Parse comma-separated indexes
        const indexStrings = indexPart.split(",").map((s) => s.trim());
        const indexes = indexStrings.map((s) => parseInt(s));

        // Validate all indexes
        const invalidIndexes = [];
        const validIndexes = [];

        for (let i = 0; i < indexes.length; i++) {
          const idx = indexes[i];
          if (isNaN(idx) || idx < 1 || idx > remindersData.reminders.length) {
            invalidIndexes.push(indexStrings[i]);
          } else if (!validIndexes.includes(idx)) {
            // Avoid duplicates
            validIndexes.push(idx);
          }
        }

        if (validIndexes.length === 0) {
          await bot.sendMessage(
            chatId,
            `❌ **Invalid index(es):** \`${invalidIndexes.join(
              ", ",
            )}\`\n\nPlease provide valid indexes between 1 and ${
              remindersData.reminders.length
            }. 📋`,
            { parse_mode: "Markdown" },
          );
        } else {
          // Sort indexes in descending order to remove from highest to lowest (prevents index shifting issues)
          validIndexes.sort((a, b) => b - a);

          for (const idx of validIndexes) {
            remindersData.reminders.splice(idx - 1, 1);
          }

          await updateReminders(chatId, remindersData.reminders);

          let responseMsg = `🗑️ **Cleared reminder(s) at index:** \`${validIndexes
            .sort((a, b) => a - b)
            .join(", ")}\` ✨`;

          if (invalidIndexes.length > 0) {
            responseMsg += `\n\n⚠️ **Skipped invalid index(es):** \`${invalidIndexes.join(
              ", ",
            )}\``;
          }

          await bot.sendMessage(chatId, responseMsg, {
            parse_mode: "Markdown",
          });
        }
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
              reminder.date === date && reminder.text === messageText,
          )
        ) {
          await bot.sendMessage(
            chatId,
            "Reminder already set for the message at the same date",
          );
        } else if (!messageText) {
          await bot.sendMessage(
            chatId,
            "Please reply to a message to set a reminder",
          );
        } else if (!date) {
          await bot.sendMessage(
            chatId,
            "Please provide a date for the reminder with the format /setreminder <yyyy-mm-dd>",
          );
        } else if (!isValidDate(date)) {
          await bot.sendMessage(
            chatId,
            "Invalid date, please provide a valid date in the format yyyy-mm-dd",
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
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("Handler Error:", error);

    // Graceful error response
    const errorMessage =
      error instanceof BotError ? error.message : "Internal Server Error";

    return new Response(
      JSON.stringify({
        message: errorMessage,
        error:
          process.env.NODE_ENV === "development" ? error.message : undefined,
      }),
      {
        status: error instanceof BotError ? error.statusCode : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing database connection...");
  await dbManager.disconnect();
  process.exit(0);
});
