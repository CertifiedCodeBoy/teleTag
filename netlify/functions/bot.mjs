//bot.mjs
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import {
  DEFAULT_RESIDENCE,
  MEAL_OPTIONS,
  authenticateWebEtu,
  decryptSecret,
  encryptSecret,
  executeReservationForAccounts,
  exchangeOnouToken,
  fetchDepots,
  fetchResidenceSuggestions,
  getAlgeriaDateKey,
  hasEncryptionKey,
  maskIdentifier,
  parseChunkCredentials,
} from "./reserve-utils.mjs";

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
      await this.db.collection("wheelOptions").createIndex({ chatId: 1 });
      await this.db
        .collection("mealReservations")
        .createIndex({ ownerUserId: 1 }, { unique: true });
      await this.db
        .collection("mealReservationOnboarding")
        .createIndex({ userId: 1 }, { unique: true });
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
        `Gemini API error: ${response.status} - ${errorData.error?.message || "Unknown error"
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

// ============================================
// FILE HANDLING & MULTIMODAL GEMINI
// ============================================

async function downloadTelegramFile(fileId) {
  const infoRes = await fetch(
    `https://api.telegram.org/bot${process.env.TOKEN}/getFile?file_id=${fileId}`,
  );
  if (!infoRes.ok) throw new Error("Failed to get file info from Telegram");
  const infoData = await infoRes.json();
  if (!infoData.ok) throw new Error("Telegram getFile error");

  const fileUrl = `https://api.telegram.org/file/bot${process.env.TOKEN}/${infoData.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error("Failed to download file from Telegram");

  const arrayBuffer = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}

// Extract file info from a Telegram message (document or photo)
function extractFileFromMessage(msg) {
  if (!msg) return null;
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      mimeType: msg.document.mime_type || "application/octet-stream",
      fileName: msg.document.file_name || "file",
    };
  }
  if (msg.photo && msg.photo.length > 0) {
    // Use the highest resolution photo
    return {
      fileId: msg.photo[msg.photo.length - 1].file_id,
      mimeType: "image/jpeg",
      fileName: "photo.jpg",
    };
  }
  return null;
}

async function callGeminiAPIMultimodal(
  promptText,
  fileBase64,
  mimeType,
  retries = CONFIG.MAX_RETRIES,
) {
  await trackAPIUsage();

  if (!process.env.GEMINI_API_KEY) {
    throw new BotError("GEMINI_API_KEY not configured", "MISSING_API_KEY", 500);
  }

  // Supported multimodal MIME types for Gemini
  const supportedMimes = [
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "application/pdf",
    "text/plain",
  ];
  const effectiveMime = supportedMimes.includes(mimeType)
    ? mimeType
    : "application/octet-stream";

  const model = "gemini-2.5-flash";
  const baseURL = "https://generativelanguage.googleapis.com/v1beta/models";

  try {
    const response = await fetch(
      `${baseURL}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: promptText },
                {
                  inline_data: {
                    mime_type: effectiveMime,
                    data: fileBase64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.4,
            topP: 0.9,
            maxOutputTokens: 4096,
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
      if (
        response.status === 429 ||
        errorData.error?.message?.includes("quota")
      ) {
        throw new BotError("QUOTA_EXCEEDED", "QUOTA_EXCEEDED", 429);
      }
      if (response.status >= 500 && retries > 0) {
        await new Promise((r) => setTimeout(r, CONFIG.RETRY_DELAY));
        return callGeminiAPIMultimodal(
          promptText,
          fileBase64,
          mimeType,
          retries - 1,
        );
      }
      throw new BotError(
        `Gemini multimodal error: ${response.status}`,
        "API_ERROR",
        response.status,
      );
    }

    const data = await response.json();
    if (!data.candidates || data.candidates.length === 0) {
      throw new BotError("No response from Gemini", "NO_RESPONSE", 500);
    }
    return data.candidates[0].content.parts[0].text;
  } catch (error) {
    if (error instanceof BotError) throw error;
    if (error.name === "TypeError" && retries > 0) {
      await new Promise((r) => setTimeout(r, CONFIG.RETRY_DELAY));
      return callGeminiAPIMultimodal(
        promptText,
        fileBase64,
        mimeType,
        retries - 1,
      );
    }
    throw new BotError("Network error", "NETWORK_ERROR", 500);
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

async function getWheelOptions(chatId) {
  const cacheKey = getCacheKey("wheel", chatId);
  const cached = getFromCache(cacheKey);
  if (cached) return cached;

  const collection = dbManager.getCollection("wheelOptions");
  const data = await collection.findOne({ chatId });
  const result = data || { chatId, options: [] };

  setCache(cacheKey, result);
  return result;
}

async function updateWheelOptions(chatId, options) {
  const collection = dbManager.getCollection("wheelOptions");
  await collection.updateOne(
    { chatId },
    { $set: { options, lastUpdated: new Date() } },
    { upsert: true },
  );
  const cacheKey = getCacheKey("wheel", chatId);
  cache.delete(cacheKey);
}

const RESERVE_COMMANDS = new Set([
  "/reserve",
  "/reserveedit",
  "/reservestatus",
  "/reservestop",
  "/reservecancel",
]);

const ADMIN_USER_IDS = new Set(
  String(process.env.ADMIN_USER_IDS || "")
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean),
);

function isAdminUser(userId) {
  return ADMIN_USER_IDS.has(String(userId));
}

function formatReservationHealth(snapshot) {
  const nowAlgeria = new Date().toLocaleString("fr-FR", {
    timeZone: "Africa/Algiers",
  });

  const recentIssuesText = snapshot.recentIssues.length
    ? snapshot.recentIssues
      .map((item, index) => {
        const run = item.lastRun || {};
        return `${index + 1}. user ${item.ownerUserId} | ${run.status || "unknown"} | attempt ${run.attempt || 0}/2 | success ${run.successCount || 0} | failed ${run.failedCount || 0}`;
      })
      .join("\n")
    : "None";

  return [
    "Reservation health",
    `Now (Algeria): ${nowAlgeria}`,
    `Encryption key configured: ${snapshot.encryptionConfigured ? "Yes" : "No"}`,
    `Total profiles: ${snapshot.totalProfiles}`,
    `Auto-enabled profiles: ${snapshot.autoEnabledProfiles}`,
    `Active onboarding sessions: ${snapshot.onboardingSessions}`,
    "",
    `Today key: ${snapshot.todayKey}`,
    `Today success: ${snapshot.todaySuccess}`,
    `Today partial: ${snapshot.todayPartial}`,
    `Today failed: ${snapshot.todayFailed}`,
    `Pending retry (attempt < 2): ${snapshot.pendingRetry}`,
    "",
    "Recent non-success auto runs:",
    recentIssuesText,
  ].join("\n");
}

async function getReservationHealthSnapshot() {
  const reservations = dbManager.getCollection("mealReservations");
  const onboarding = dbManager.getCollection("mealReservationOnboarding");
  const todayKey = getAlgeriaDateKey();

  const [
    totalProfiles,
    autoEnabledProfiles,
    onboardingSessions,
    todaySuccess,
    todayPartial,
    todayFailed,
    pendingRetry,
    recentIssues,
  ] = await Promise.all([
    reservations.countDocuments({}),
    reservations.countDocuments({ autoEnabled: true }),
    onboarding.countDocuments({}),
    reservations.countDocuments({
      "lastRun.dayKey": todayKey,
      "lastRun.status": "success",
    }),
    reservations.countDocuments({
      "lastRun.dayKey": todayKey,
      "lastRun.status": "partial",
    }),
    reservations.countDocuments({
      "lastRun.dayKey": todayKey,
      "lastRun.status": "failed",
    }),
    reservations.countDocuments({
      autoEnabled: true,
      "lastRun.dayKey": todayKey,
      "lastRun.status": { $ne: "success" },
      "lastRun.attempt": { $lt: 2 },
    }),
    reservations
      .find({
        autoEnabled: true,
        "lastRun.dayKey": todayKey,
        "lastRun.status": { $ne: "success" },
      })
      .sort({ updatedAt: -1 })
      .limit(5)
      .project({
        ownerUserId: 1,
        lastRun: 1,
      })
      .toArray(),
  ]);

  return {
    encryptionConfigured: hasEncryptionKey(),
    totalProfiles,
    autoEnabledProfiles,
    onboardingSessions,
    todayKey,
    todaySuccess,
    todayPartial,
    todayFailed,
    pendingRetry,
    recentIssues,
  };
}

function normalizeBotCommand(text) {
  const first = String(text || "")
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
  return first.replace("@tagallesisbabot", "");
}

function isPrivateChat(msg) {
  return msg?.chat?.type === "private";
}

function mealTypesToText(mealTypes = []) {
  const labels = mealTypes
    .map((type) => MEAL_OPTIONS[type])
    .filter(Boolean)
    .join(", ");
  return labels || "None";
}

function buildReserveModeKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Single account",
          callback_data: "reserve:mode:single",
        },
      ],
      [
        {
          text: "Chunk accounts",
          callback_data: "reserve:mode:chunk",
        },
      ],
      [{ text: "Cancel", callback_data: "reserve:cancel" }],
    ],
  };
}

function buildResidenceChoiceKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Cite 6 (default)",
          callback_data: "reserve:residence:default",
        },
      ],
      [
        {
          text: "Suggest from API",
          callback_data: "reserve:residence:suggest",
        },
        {
          text: "Manual residence",
          callback_data: "reserve:residence:manual",
        },
      ],
      [{ text: "Cancel", callback_data: "reserve:cancel" }],
    ],
  };
}

function buildChunkPartialKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Continue with valid",
          callback_data: "reserve:chunk:continue",
        },
      ],
      [
        {
          text: "Resend credentials",
          callback_data: "reserve:chunk:resend",
        },
      ],
      [{ text: "Cancel", callback_data: "reserve:cancel" }],
    ],
  };
}

function buildDepotKeyboard(candidates = []) {
  const rows = candidates.map((item, index) => [
    {
      text: item.label,
      callback_data: `reserve:depot:pick:${index}`,
    },
  ]);

  rows.push([{ text: "Cancel", callback_data: "reserve:cancel" }]);

  return { inline_keyboard: rows };
}

function buildMealSelectionKeyboard(selectedMeals = [1, 2, 3]) {
  const has = (meal) => selectedMeals.includes(meal);

  return {
    inline_keyboard: [
      [
        {
          text: `${has(1) ? "✅" : "⬜"} Breakfast`,
          callback_data: "reserve:meal:1",
        },
        {
          text: `${has(2) ? "✅" : "⬜"} Lunch`,
          callback_data: "reserve:meal:2",
        },
      ],
      [
        {
          text: `${has(3) ? "✅" : "⬜"} Dinner`,
          callback_data: "reserve:meal:3",
        },
      ],
      [
        {
          text: "Select all",
          callback_data: "reserve:meal:all",
        },
        {
          text: "Done",
          callback_data: "reserve:meal:done",
        },
      ],
      [{ text: "Cancel", callback_data: "reserve:cancel" }],
    ],
  };
}

function buildScheduleKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "Tomorrow only",
          callback_data: "reserve:schedule:once",
        },
      ],
      [
        {
          text: "Auto daily (next 3 days)",
          callback_data: "reserve:schedule:auto",
        },
      ],
      [{ text: "Cancel", callback_data: "reserve:cancel" }],
    ],
  };
}

async function getReserveOnboarding(userId) {
  const collection = dbManager.getCollection("mealReservationOnboarding");
  return collection.findOne({ userId });
}

async function saveReserveOnboarding(userId, payload) {
  const { _id, createdAt, updatedAt, ...safePayload } = payload || {};
  console.log('[RESERVE] saveReserveOnboarding', { userId, step: safePayload.step });
  const collection = dbManager.getCollection("mealReservationOnboarding");
  await collection.updateOne(
    { userId },
    {
      $set: {
        ...safePayload,
        userId,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );

  return getReserveOnboarding(userId);
}

async function clearReserveOnboarding(userId) {
  const collection = dbManager.getCollection("mealReservationOnboarding");
  await collection.deleteOne({ userId });
}

async function getMealReservationProfile(userId) {
  const collection = dbManager.getCollection("mealReservations");
  return collection.findOne({ ownerUserId: userId });
}

async function upsertMealReservationProfile(userId, payload) {
  const { _id, createdAt, updatedAt, ...safePayload } = payload || {};
  const collection = dbManager.getCollection("mealReservations");
  await collection.updateOne(
    { ownerUserId: userId },
    {
      $set: {
        ...safePayload,
        ownerUserId: userId,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );

  return getMealReservationProfile(userId);
}

async function saveMealReservationRun(userId, runData) {
  const collection = dbManager.getCollection("mealReservations");
  await collection.updateOne(
    { ownerUserId: userId },
    {
      $set: {
        lastRun: runData,
        updatedAt: new Date(),
      },
    },
  );
}

async function stopMealReservationAuto(userId) {
  const collection = dbManager.getCollection("mealReservations");
  const result = await collection.updateOne(
    { ownerUserId: userId },
    {
      $set: {
        autoEnabled: false,
        updatedAt: new Date(),
      },
    },
  );
  return result.modifiedCount > 0;
}

async function askResidenceChoice(chatId) {
  await bot.sendMessage(
    chatId,
    "Choose your residence setup:\n\n- Quick option: Cite 6 (wilaya 22, residence 0, depot 269)\n- Suggest from API: tries common residences and lets you pick by restaurant name\n- Manual: enter wilaya,residence and pick a restaurant",
    {
      reply_markup: buildResidenceChoiceKeyboard(),
    },
  );
}

async function askMealSelection(chatId, selectedMeals = [1, 2, 3]) {
  await bot.sendMessage(chatId, "Pick meals (multi-select), then tap Done.", {
    reply_markup: buildMealSelectionKeyboard(selectedMeals),
  });
}

async function askScheduleMode(chatId) {
  await bot.sendMessage(
    chatId,
    "Choose reservation mode:\n\n- Tomorrow only: reserve one day\n- Auto daily: every day at 23:00 Algeria, reserve next 3 days",
    {
      reply_markup: buildScheduleKeyboard(),
    },
  );
}

function formatReservationRunSummary(runResult) {
  const lines = [];
  lines.push(`Dates targeted: ${runResult.dateStrings.join(", ")}`);
  lines.push(
    `Accounts success: ${runResult.successCount}/${runResult.results.length}`,
  );

  const failed = runResult.results.filter((item) => !item.success);
  if (failed.length > 0) {
    lines.push("");
    lines.push("Failed accounts:");
    for (const item of failed) {
      lines.push(`- ${maskIdentifier(item.username)}: ${item.error}`);
    }
  }

  const successful = runResult.results.filter((item) => item.success);
  if (successful.length > 0) {
    lines.push("");
    lines.push("Successful accounts:");
    for (const item of successful) {
      lines.push(
        `- ${maskIdentifier(item.username)}: submitted ${item.submittedCount || 0}, already reserved ${item.skippedAsExisting || 0}`,
      );
    }
  }

  return lines.join("\n");
}

function formatReservationStatus(profile) {
  if (!profile) {
    return "No reservation profile found yet. Use /reserve in private chat to set it up.";
  }

  const residence = profile.residence || DEFAULT_RESIDENCE;
  const accountLines = (profile.accounts || [])
    .map(
      (account, index) => `${index + 1}. ${maskIdentifier(account.username)}`,
    )
    .join("\n");

  const lastRun = profile.lastRun
    ? `${profile.lastRun.status} on ${new Date(
      profile.lastRun.attemptedAt,
    ).toLocaleString("fr-FR", {
      timeZone: "Africa/Algiers",
    })}`
    : "No run yet";

  return [
    "Reservation status",
    `Mode: ${profile.mode || "single"}`,
    `Auto enabled: ${profile.autoEnabled ? "Yes" : "No"}`,
    `Meals: ${mealTypesToText(profile.mealTypes || [1, 2, 3])}`,
    `Residence: ${residence.label || "Custom"} (wilaya ${residence.wilaya}, residence ${residence.residence}, depot ${residence.idDepot})`,
    "Accounts:",
    accountLines || "No accounts",
    `Last run: ${lastRun}`,
  ].join("\n");
}

async function fetchDepotCandidatesForResidence(account, wilaya, residence) {
  console.log('[RESERVE] fetchDepotCandidatesForResidence START', { username: account.username, wilaya, residence });
  try {
    const password = decryptSecret(account.passwordEncrypted);
    const auth = await authenticateWebEtu(account.username, password);
    if (!auth.ok) {
      return {
        ok: false,
        error: `Failed to validate account before depot lookup: ${auth.error}`,
        candidates: [],
      };
    }

    const onou = await exchangeOnouToken({
      uuid: auth.uuid,
      webetuToken: auth.token,
      wilaya,
      residence,
      idIndividu: auth.idIndividu,
      idDia: auth.idDia,
    });

    if (!onou.ok) {
      return {
        ok: false,
        error: `Could not open this residence: ${onou.error}`,
        candidates: [],
      };
    }

    const depots = await fetchDepots({
      uuid: auth.uuid,
      onouToken: onou.onouToken,
      wilaya,
      residence,
    });

    if (!depots.ok || depots.depots.length === 0) {
      return {
        ok: false,
        error: depots.error || "No restaurants found for this residence",
        candidates: [],
      };
    }

    const candidates = depots.depots.map((depot) => ({
      label: `${depot.depotLabel} (Depot ${depot.idDepot})`,
      wilaya: String(wilaya),
      residence: String(residence),
      idDepot: Number(depot.idDepot),
      depotLabel: depot.depotLabel,
    }));

    console.log('[RESERVE] fetchDepotCandidatesForResidence SUCCESS', { candidateCount: candidates.length });
    return { ok: true, candidates };
  } catch (error) {
    return {
      ok: false,
      error: error.message || "Failed to fetch depots",
      candidates: [],
    };
  }
}

async function verifyAndEncryptAccounts(accounts) {
  console.log('[RESERVE] verifyAndEncryptAccounts START', { accountCount: accounts.length });
  const valid = [];
  const invalid = [];

  const seen = new Set();
  for (const entry of accounts) {
    const username = String(entry.username || "").trim();
    const password = String(entry.password || "").trim();

    if (!username || !password) {
      invalid.push({
        username: username || "(empty)",
        error: "Missing username or password",
      });
      continue;
    }

    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const auth = await authenticateWebEtu(username, password);
    if (!auth.ok) {
      invalid.push({ username, error: auth.error });
      continue;
    }

    valid.push({
      username,
      passwordEncrypted: encryptSecret(password),
    });
  }

  console.log('[RESERVE] verifyAndEncryptAccounts DONE', { validCount: valid.length, invalidCount: invalid.length });
  return { valid, invalid };
}

async function startReserveOnboarding(chatId, userId, isEdit = false) {
  console.log('[RESERVE] startReserveOnboarding', { chatId, userId, isEdit });
  if (!hasEncryptionKey()) {
    console.log('[RESERVE] encryption key missing, aborting onboarding');
    await bot.sendMessage(
      chatId,
      "Reservation setup is not available right now because encryption is not configured on the server.",
    );
    return;
  }

  await saveReserveOnboarding(userId, {
    ownerChatId: chatId,
    step: "pick_mode",
    mode: null,
    accounts: [],
    pendingValidAccounts: [],
    pendingInvalidAccounts: [],
    depotCandidates: [],
    mealTypes: [1, 2, 3],
    residence: null,
    tempUsername: null,
  });

  await bot.sendMessage(
    chatId,
    isEdit
      ? "Updating your reservation profile. Current profile stays unchanged until this setup completes.\n\nYour passwords are encrypted before being stored in MongoDB.\n\nChoose account mode:"
      : "Let us set up /reserve.\n\nYour passwords are encrypted before being stored in MongoDB.\n\nChoose account mode:",
    {
      reply_markup: buildReserveModeKeyboard(),
    },
  );
}

async function finalizeReserveConfiguration(
  userId,
  chatId,
  state,
  scheduleMode,
) {
  console.log('[RESERVE] finalizeReserveConfiguration START', { userId, scheduleMode, mode: state.mode, accountCount: state.accounts?.length, residence: state.residence?.label });
  const autoEnabled = scheduleMode === "auto";
  const reserveDaysAhead = autoEnabled ? 3 : 1;

  const payload = {
    ownerChatId: chatId,
    mode: state.mode || "single",
    accounts: state.accounts || [],
    residence: state.residence || DEFAULT_RESIDENCE,
    mealTypes:
      Array.isArray(state.mealTypes) && state.mealTypes.length > 0
        ? state.mealTypes
        : [1, 2, 3],
    autoEnabled,
    reserveDaysAhead,
  };

  const profile = await upsertMealReservationProfile(userId, payload);
  console.log('[RESERVE] profile saved, starting reservation run', { autoEnabled, reserveDaysAhead });

  await bot.sendMessage(
    chatId,
    autoEnabled
      ? "Profile saved. Running first auto reservation now (next 3 days)..."
      : "Profile saved. Running reservation now for tomorrow...",
  );

  const runResult = await executeReservationForAccounts(profile, {
    daysAhead: reserveDaysAhead,
  });

  console.log('[RESERVE] reservation run completed', { overallStatus: runResult.overallStatus, successCount: runResult.successCount, failedCount: runResult.failedCount });
  await saveMealReservationRun(userId, {
    status: runResult.overallStatus,
    attemptedAt: new Date().toISOString(),
    successCount: runResult.successCount,
    failedCount: runResult.failedCount,
    dateStrings: runResult.dateStrings,
    results: runResult.results,
  });

  await clearReserveOnboarding(userId);
  console.log('[RESERVE] finalizeReserveConfiguration DONE', { userId });

  const modeText = autoEnabled
    ? "Auto mode is enabled. Daily execution should run at 23:00 Algeria time and reserve next 3 days."
    : "Tomorrow-only reservation is done. Auto mode is disabled.";

  await bot.sendMessage(
    chatId,
    `${modeText}\n\n${formatReservationRunSummary(runResult)}\n\nUse /reservestatus to view profile, /reserveedit to change settings, /reservestop to disable auto mode.`,
  );
}

async function handleReserveCommand(normalizedCommand, chatId, userId, msg) {
  if (!isPrivateChat(msg)) {
    await bot.sendMessage(
      chatId,
      "Reservation commands are available only in private chat with the bot. Please message me in DM.",
    );
    return;
  }

  if (normalizedCommand === "/reservecancel") {
    await clearReserveOnboarding(userId);
    await bot.sendMessage(chatId, "Reservation setup canceled.");
    return;
  }

  if (normalizedCommand === "/reservestatus") {
    const profile = await getMealReservationProfile(userId);
    await bot.sendMessage(chatId, formatReservationStatus(profile));
    return;
  }

  if (normalizedCommand === "/reservestop") {
    const stopped = await stopMealReservationAuto(userId);
    await bot.sendMessage(
      chatId,
      stopped
        ? "Auto reservation has been disabled."
        : "No active auto reservation profile found.",
    );
    return;
  }

  if (normalizedCommand === "/reserveedit") {
    await startReserveOnboarding(chatId, userId, true);
    return;
  }

  if (normalizedCommand === "/reserve") {
    await startReserveOnboarding(chatId, userId, false);
  }
}

async function handleReserveFlowText(msg, text) {
  if (!isPrivateChat(msg)) return false;

  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const state = await getReserveOnboarding(userId);
  if (!state) return false;
  console.log('[RESERVE] handleReserveFlowText', { userId, step: state.step });

  const normalizedCommand = normalizeBotCommand(text);
  if (RESERVE_COMMANDS.has(normalizedCommand)) {
    return false;
  }

  if (text.startsWith("/")) {
    await bot.sendMessage(
      chatId,
      "You are in /reserve setup. Finish this step or use /reservecancel.",
    );
    return true;
  }

  if (state.step === "single_username") {
    const username = text.trim();
    console.log('[RESERVE] single_username received', { userId, username });
    if (!username) {
      await bot.sendMessage(
        chatId,
        "Please send a valid WebEtu email/identifier.",
      );
      return true;
    }

    await saveReserveOnboarding(userId, {
      ...state,
      tempUsername: username,
      step: "single_password",
    });

    await bot.sendMessage(
      chatId,
      "Now send your password. Do not worry, it will be encrypted before storage.",
    );
    return true;
  }

  if (state.step === "single_password") {
    const password = text.trim();
    if (!password) {
      await bot.sendMessage(
        chatId,
        "Password cannot be empty. Please send it again.",
      );
      return true;
    }

    if (!state.tempUsername) {
      await bot.sendMessage(
        chatId,
        "Session data is incomplete. Please restart with /reserve.",
      );
      await clearReserveOnboarding(userId);
      return true;
    }

    await bot.sendMessage(chatId, "Verifying credentials...");
    console.log('[RESERVE] single_password verifying', { userId, username: state.tempUsername });
    const auth = await authenticateWebEtu(state.tempUsername, password);
    if (!auth.ok) {
      console.log('[RESERVE] single_password auth FAILED', { userId, error: auth.error });
      await bot.sendMessage(
        chatId,
        `Credentials not valid for ${maskIdentifier(state.tempUsername)}. Error: ${auth.error}\n\nTry again or use /reservecancel.`,
      );
      return true;
    }

    console.log('[RESERVE] single_password auth SUCCESS, moving to pick_residence', { userId });
    await saveReserveOnboarding(userId, {
      ...state,
      mode: "single",
      accounts: [
        {
          username: state.tempUsername,
          passwordEncrypted: encryptSecret(password),
        },
      ],
      tempUsername: null,
      mealTypes: [1, 2, 3],
      step: "pick_residence",
    });

    await askResidenceChoice(chatId);
    return true;
  }

  if (state.step === "chunk_credentials") {
    console.log('[RESERVE] chunk_credentials received', { userId });
    const parsed = parseChunkCredentials(text);

    if (parsed.validEntries.length === 0) {
      await bot.sendMessage(
        chatId,
        "No valid account format found.\nUse one per line or comma-separated: username:password",
      );
      return true;
    }

    await bot.sendMessage(chatId, "Verifying chunk credentials...");
    console.log('[RESERVE] chunk_credentials verifying', { userId, validEntries: parsed.validEntries.length, invalidEntries: parsed.invalidEntries.length });
    const verification = await verifyAndEncryptAccounts(parsed.validEntries);

    if (verification.valid.length === 0) {
      const invalidLines = verification.invalid
        .map((item) => `- ${maskIdentifier(item.username)}: ${item.error}`)
        .join("\n");

      await bot.sendMessage(
        chatId,
        `None of the provided accounts were valid.\n\n${invalidLines}\n\nPlease resend chunk credentials.`,
      );
      return true;
    }

    if (verification.invalid.length > 0 || parsed.invalidEntries.length > 0) {
      console.log('[RESERVE] chunk partial - some accounts failed', { userId, validCount: verification.valid.length, invalidCount: verification.invalid.length });
      const invalidFromFormat = parsed.invalidEntries.map(
        (item) => `- ${item} (invalid format)`,
      );
      const invalidFromAuth = verification.invalid.map(
        (item) => `- ${maskIdentifier(item.username)}: ${item.error}`,
      );

      await saveReserveOnboarding(userId, {
        ...state,
        mode: "chunk",
        pendingValidAccounts: verification.valid,
        pendingInvalidAccounts: [...invalidFromFormat, ...invalidFromAuth],
        step: "chunk_confirm_partial",
      });

      await bot.sendMessage(
        chatId,
        `Some accounts failed:\n${[...invalidFromFormat, ...invalidFromAuth].join("\n")}\n\nContinue with valid accounts or resend all credentials?`,
        {
          reply_markup: buildChunkPartialKeyboard(),
        },
      );
      return true;
    }

    console.log('[RESERVE] chunk all valid, moving to pick_residence', { userId, accountCount: verification.valid.length });
    await saveReserveOnboarding(userId, {
      ...state,
      mode: "chunk",
      accounts: verification.valid,
      mealTypes: [1, 2, 3],
      step: "pick_residence",
    });
    await askResidenceChoice(chatId);
    return true;
  }

  if (state.step === "manual_residence_input") {
    console.log('[RESERVE] manual_residence_input received', { userId, text });
    const parts = text
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length !== 2 && parts.length !== 3) {
      await bot.sendMessage(
        chatId,
        "Invalid format. Send wilaya,residence OR wilaya,residence,idDepot\nExample: 22,0 OR 22,0,269",
      );
      return true;
    }

    const [wilaya, residence, idDepotRaw] = parts;
    if (!wilaya || !residence) {
      await bot.sendMessage(chatId, "Wilaya and residence are required.");
      return true;
    }

    if (parts.length === 3) {
      const idDepot = Number(idDepotRaw);
      if (!Number.isFinite(idDepot) || idDepot <= 0) {
        await bot.sendMessage(
          chatId,
          "Invalid idDepot. Please send a numeric value.",
        );
        return true;
      }

      await saveReserveOnboarding(userId, {
        ...state,
        residence: {
          label: `Custom ${wilaya}/${residence}`,
          wilaya,
          residence,
          idDepot,
          depotLabel: `Depot ${idDepot}`,
        },
        mealTypes: state.mealTypes?.length ? state.mealTypes : [1, 2, 3],
        step: "pick_meals",
      });

      await askMealSelection(
        chatId,
        state.mealTypes?.length ? state.mealTypes : [1, 2, 3],
      );
      return true;
    }

    const baseAccount = state.accounts?.[0];
    if (!baseAccount) {
      await bot.sendMessage(
        chatId,
        "No account available for depot lookup. Restart with /reserve.",
      );
      await clearReserveOnboarding(userId);
      return true;
    }

    await bot.sendMessage(
      chatId,
      "Looking up restaurants for this residence...",
    );
    const lookup = await fetchDepotCandidatesForResidence(
      baseAccount,
      wilaya,
      residence,
    );

    if (!lookup.ok || lookup.candidates.length === 0) {
      await bot.sendMessage(
        chatId,
        `${lookup.error || "No restaurant options found"}.\nYou can still send wilaya,residence,idDepot manually.`,
      );
      return true;
    }

    await saveReserveOnboarding(userId, {
      ...state,
      depotCandidates: lookup.candidates,
      step: "pick_depot",
    });

    await bot.sendMessage(chatId, "Pick your restaurant:", {
      reply_markup: buildDepotKeyboard(lookup.candidates),
    });
    return true;
  }

  await bot.sendMessage(
    chatId,
    "Please use the provided buttons, or /reservecancel to stop setup.",
  );
  return true;
}

async function handleReserveCallback(callbackQuery) {
  const data = callbackQuery.data || "";
  if (!data.startsWith("reserve:")) return false;
  console.log('[RESERVE] handleReserveCallback', { data, userId: callbackQuery.from.id });

  try {
    await bot.answerCallbackQuery(callbackQuery.id);
  } catch (_) {
    // ignore callback timeout
  }

  const msg = callbackQuery.message;
  const chatId = msg.chat.id;
  const userId = callbackQuery.from.id;

  if (!isPrivateChat(msg)) {
    await bot.sendMessage(
      chatId,
      "Reservation setup is private-only. Please continue in DM with the bot.",
    );
    return true;
  }

  if (data === "reserve:cancel") {
    console.log('[RESERVE] user cancelled setup', { userId });
    await clearReserveOnboarding(userId);
    await bot.sendMessage(chatId, "Reservation setup canceled.");
    return true;
  }

  const state = await getReserveOnboarding(userId);
  if (!state) {
    console.log('[RESERVE] onboarding session not found (expired)', { userId });
    await bot.sendMessage(
      chatId,
      "Setup session expired. Send /reserve to start again.",
    );
    return true;
  }
  console.log('[RESERVE] current onboarding state', { userId, step: state.step, mode: state.mode });

  if (data === "reserve:mode:single") {
    console.log('[RESERVE] mode selected: single', { userId });
    await saveReserveOnboarding(userId, {
      ...state,
      mode: "single",
      mealTypes: [1, 2, 3],
      step: "single_username",
    });
    await bot.sendMessage(chatId, "Send your WebEtu email/identifier:");
    return true;
  }

  if (data === "reserve:mode:chunk") {
    console.log('[RESERVE] mode selected: chunk', { userId });
    await saveReserveOnboarding(userId, {
      ...state,
      mode: "chunk",
      mealTypes: [1, 2, 3],
      step: "chunk_credentials",
    });
    await bot.sendMessage(
      chatId,
      "Send chunk credentials in one message.\nFormat accepted:\n- One per line: username:password\n- Or comma-separated: user1:pass1, user2:pass2",
    );
    return true;
  }

  if (data === "reserve:chunk:continue") {
    if (
      state.step !== "chunk_confirm_partial" ||
      !Array.isArray(state.pendingValidAccounts) ||
      state.pendingValidAccounts.length === 0
    ) {
      await bot.sendMessage(
        chatId,
        "No valid chunk accounts available to continue.",
      );
      return true;
    }

    await saveReserveOnboarding(userId, {
      ...state,
      accounts: state.pendingValidAccounts,
      pendingValidAccounts: [],
      pendingInvalidAccounts: [],
      step: "pick_residence",
    });

    await askResidenceChoice(chatId);
    return true;
  }

  if (data === "reserve:chunk:resend") {
    await saveReserveOnboarding(userId, {
      ...state,
      pendingValidAccounts: [],
      pendingInvalidAccounts: [],
      step: "chunk_credentials",
    });
    await bot.sendMessage(
      chatId,
      "Please resend chunk credentials in username:password format.",
    );
    return true;
  }

  if (data === "reserve:residence:default") {
    console.log('[RESERVE] residence selected: default (Cite 6)', { userId });
    await saveReserveOnboarding(userId, {
      ...state,
      residence: DEFAULT_RESIDENCE,
      mealTypes: state.mealTypes?.length ? state.mealTypes : [1, 2, 3],
      step: "pick_meals",
    });
    await askMealSelection(
      chatId,
      state.mealTypes?.length ? state.mealTypes : [1, 2, 3],
    );
    return true;
  }

  if (data === "reserve:residence:manual") {
    await saveReserveOnboarding(userId, {
      ...state,
      step: "manual_residence_input",
    });
    await bot.sendMessage(
      chatId,
      "Send residence info as:\n- wilaya,residence\n- or wilaya,residence,idDepot\n\nExample: 22,0 or 22,0,269",
    );
    return true;
  }

  if (data === "reserve:residence:suggest") {
    console.log('[RESERVE] residence: fetching suggestions', { userId });
    const baseAccount = state.accounts?.[0];
    if (!baseAccount) {
      await bot.sendMessage(
        chatId,
        "No verified account found. Restart with /reserve.",
      );
      await clearReserveOnboarding(userId);
      return true;
    }

    await bot.sendMessage(chatId, "Fetching residence suggestions from API...");

    let password;
    try {
      password = decryptSecret(baseAccount.passwordEncrypted);
    } catch (error) {
      await bot.sendMessage(
        chatId,
        `Could not read encrypted credentials: ${error.message}`,
      );
      await clearReserveOnboarding(userId);
      return true;
    }

    const suggestionsResult = await fetchResidenceSuggestions({
      username: baseAccount.username,
      password,
      wilaya: "22",
      maxSuggestions: 8,
    });

    if (!suggestionsResult.ok || suggestionsResult.suggestions.length === 0) {
      console.log('[RESERVE] residence suggestions FAILED', { error: suggestionsResult.error });
      await bot.sendMessage(
        chatId,
        `${suggestionsResult.error || "No suggestions available"}. You can pick manual residence instead.`,
      );
      return true;
    }

    const candidates = suggestionsResult.suggestions.map((item) => ({
      label: item.label,
      wilaya: item.wilaya,
      residence: item.residence,
      idDepot: item.idDepot,
      depotLabel: item.depotLabel,
    }));

    await saveReserveOnboarding(userId, {
      ...state,
      depotCandidates: candidates,
      step: "pick_depot",
    });

    await bot.sendMessage(chatId, "Choose one suggested restaurant:", {
      reply_markup: buildDepotKeyboard(candidates),
    });
    return true;
  }

  if (data.startsWith("reserve:depot:pick:")) {
    if (
      !Array.isArray(state.depotCandidates) ||
      state.depotCandidates.length === 0
    ) {
      await bot.sendMessage(
        chatId,
        "No depot options found in session. Restart with /reserve.",
      );
      return true;
    }

    const index = Number(data.split(":").pop());
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= state.depotCandidates.length
    ) {
      await bot.sendMessage(chatId, "Invalid restaurant selection.");
      return true;
    }

    const selected = state.depotCandidates[index];
    console.log('[RESERVE] depot selected', { userId, label: selected.label, idDepot: selected.idDepot });
    await saveReserveOnboarding(userId, {
      ...state,
      residence: {
        label: selected.label,
        wilaya: selected.wilaya,
        residence: selected.residence,
        idDepot: selected.idDepot,
        depotLabel: selected.depotLabel,
      },
      mealTypes: state.mealTypes?.length ? state.mealTypes : [1, 2, 3],
      step: "pick_meals",
    });

    await askMealSelection(
      chatId,
      state.mealTypes?.length ? state.mealTypes : [1, 2, 3],
    );
    return true;
  }

  if (data === "reserve:meal:all") {
    await saveReserveOnboarding(userId, {
      ...state,
      mealTypes: [1, 2, 3],
      step: "pick_meals",
    });
    await askMealSelection(chatId, [1, 2, 3]);
    return true;
  }

  if (["reserve:meal:1", "reserve:meal:2", "reserve:meal:3"].includes(data)) {
    const mealType = Number(data.split(":").pop());
    const current = Array.isArray(state.mealTypes)
      ? [...state.mealTypes]
      : [1, 2, 3];

    const index = current.indexOf(mealType);
    if (index >= 0) {
      current.splice(index, 1);
    } else {
      current.push(mealType);
    }

    current.sort((a, b) => a - b);

    await saveReserveOnboarding(userId, {
      ...state,
      mealTypes: current,
      step: "pick_meals",
    });
    await askMealSelection(chatId, current);
    return true;
  }

  if (data === "reserve:meal:done") {
    const selected = Array.isArray(state.mealTypes) ? state.mealTypes : [];
    if (selected.length === 0) {
      await bot.sendMessage(
        chatId,
        "Please select at least one meal before continuing.",
      );
      await askMealSelection(chatId, selected);
      return true;
    }

    await saveReserveOnboarding(userId, {
      ...state,
      step: "pick_schedule",
    });
    console.log('[RESERVE] meals done, moving to schedule', { userId, mealTypes: selected });
    await askScheduleMode(chatId);
    return true;
  }

  if (data === "reserve:schedule:once" || data === "reserve:schedule:auto") {
    const mode = data.endsWith(":auto") ? "auto" : "once";
    console.log('[RESERVE] schedule selected', { userId, mode });

    if (!Array.isArray(state.accounts) || state.accounts.length === 0) {
      await bot.sendMessage(
        chatId,
        "No accounts found in setup. Restart with /reserve.",
      );
      await clearReserveOnboarding(userId);
      return true;
    }

    if (!state.residence) {
      await bot.sendMessage(
        chatId,
        "No residence selected. Restart with /reserve.",
      );
      await clearReserveOnboarding(userId);
      return true;
    }

    console.log('[RESERVE] calling finalizeReserveConfiguration', { userId, mode, accountCount: state.accounts.length, residence: state.residence?.label });
    await finalizeReserveConfiguration(userId, chatId, state, mode);
    return true;
  }

  await bot.sendMessage(
    chatId,
    "Unknown reservation action. Use /reserve to restart.",
  );
  return true;
}

async function spinWheel(chatId, options) {
  const winner = options[Math.floor(Math.random() * options.length)];

  // Build the initial message with pointer on top item
  function buildFrame(highlighted) {
    return options
      .map((o) => (o === highlighted ? `▶️ *${o}* ◀️` : `     ${o}`))
      .join("\n");
  }

  const sent = await bot.sendMessage(
    chatId,
    `🎡 *Spinning the wheel...*\n\n${buildFrame(options[0])}`,
    { parse_mode: "Markdown" },
  );

  // Animate: cycle pointer through options a few times then land on winner
  const frames = [];
  const cycles = 2;
  for (let c = 0; c < cycles; c++) {
    for (const o of options) frames.push(o);
  }
  // Slow down toward the end by repeating winner neighbours
  frames.push(
    options[(options.indexOf(winner) - 1 + options.length) % options.length],
  );
  frames.push(winner);

  const delays = frames.map((_, i) => {
    // Start fast (150ms), ease out to 500ms over last quarter
    const progress = i / frames.length;
    return Math.round(150 + progress * 350);
  });

  for (let i = 0; i < frames.length; i++) {
    await new Promise((r) => setTimeout(r, delays[i]));
    try {
      await bot.editMessageText(
        `🎡 *Spinning the wheel...*\n\n${buildFrame(frames[i])}`,
        {
          chat_id: chatId,
          message_id: sent.message_id,
          parse_mode: "Markdown",
        },
      );
    } catch (_) {
      /* ignore edit-too-fast errors */
    }
  }

  // Final result
  await new Promise((r) => setTimeout(r, 600));
  await bot.editMessageText(
    `🎡 *The wheel has spoken!*\n\n🏆 **${winner}** 🎉`,
    { chat_id: chatId, message_id: sent.message_id, parse_mode: "Markdown" },
  );
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
          return "ولي غدوة وليدو";
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

async function generateQCM(topic) {
  const sanitized = sanitizeInput(topic);
  const prompt = `You are an assistant generating a QCM (Questionnaire à Choix Multiple) for Algerian university students.

Generate exactly 5 multiple choice questions about: ${sanitized}

Format each question EXACTLY like this:
**Q1.** [question text]
A) [option]
B) [option]
C) [option]
D) [option]

After all 5 questions, add a line break then write:
**Réponses:** ||Q1:X, Q2:X, Q3:X, Q4:X, Q5:X|| (replace X with correct letter)

Only output the questions and the answers line. Nothing else.`;
  return await callGeminiAPI(prompt);
}

async function solveWithAI(guide, fileBase64, mimeType) {
  const sanitizedGuide = guide ? sanitizeInput(guide) : "";

  const languageHint = (() => {
    const g = sanitizedGuide.toLowerCase();
    if (g.includes("java") && !g.includes("javascript")) return "Java";
    if (g.includes("javascript") || g.includes(" js ") || g.includes("js:"))
      return "JavaScript";
    if (g.includes("python")) return "Python";
    if (g.includes("arduino")) return "Arduino (C++)";
    if (g.includes("c++")) return "C++";
    if (g.includes(" c ") || g.includes("langage c")) return "C";
    if (g.includes("sql")) return "SQL";
    if (g.includes("html") || g.includes("css")) return "HTML/CSS";
    return null;
  })();

  let prompt;
  if (fileBase64) {
    prompt = `You are an expert academic assistant helping Algerian university students solve exercises.

Analyze the file and solve every question/exercise you find in it.

**Output rules (follow strictly):**
- If the content is mathematical, physical, or theoretical → write the full solution in LaTeX (use \\( \\) for inline math, \\[ \\] for display math).
- If the content is a programming exercise → write clean, complete, commented code.${languageHint ? `\n- The student specifically wants the solution in **${languageHint}**.` : "\n- Auto-detect the required language from the exercise (Java, Python, JavaScript, Arduino, C, C++, SQL, etc.)"}
- If the file contains multiple exercises, solve each one clearly separated.
- Do NOT add meta-commentary, preambles, or «here is the solution» text. Go straight to the work.${sanitizedGuide ? `\n\nAdditional instructions from student: ${sanitizedGuide}` : ""}`;
  } else {
    // Text-only solve
    prompt = `You are an expert academic assistant helping Algerian university students.

Solve the following problem completely:

${sanitizedGuide}

**Output rules:**
- Mathematical/theoretical content → LaTeX (use \\( \\) for inline, \\[ \\] for display math).
- Programming problems → clean, complete, commented code.${languageHint ? ` Use **${languageHint}**.` : " Auto-detect the language."}
- Go straight to the solution without meta-commentary.`;
  }

  if (fileBase64) {
    return await callGeminiAPIMultimodal(prompt, fileBase64, mimeType);
  } else {
    return await callGeminiAPI(prompt);
  }
}

async function generateEmail(description) {
  const sanitized = sanitizeInput(description);

  // Determine greeting based on Algeria local time (UTC+1)
  const algeriaHour = new Date(Date.now() + 3600000).getUTCHours();
  const greeting = algeriaHour >= 18 ? "Bonsoir" : "Bonjour";

  // Detect gender hint from description keywords
  const lower = sanitized.toLowerCase();
  const masculineHints = [
    "monsieur",
    "professeur",
    "directeur",
    "doyen",
    "chef",
    " m.",
    " mr",
    " sir",
    " him",
    " his",
    "male",
    "homme",
  ];
  const feminineHints = [
    "madame",
    "professeure",
    "directrice",
    "doyenne",
    " mme",
    " ms",
    " mrs",
    " her",
    "female",
    "femme",
  ];
  const isMasc = masculineHints.some((w) => lower.includes(w));
  const isFem = feminineHints.some((w) => lower.includes(w));
  const civility = isMasc ? "Monsieur" : isFem ? "Madame" : "Monsieur/Madame";

  const prompt = `You are an assistant that writes formal French academic emails for Algerian university students.

The user will describe what they need in English or Arabic. Generate a formal French email following this EXACT template — output ONLY the email, nothing else:

Subject: "[subject in French]"

${greeting} ${civility},

[email body — formal, concise French, 2-4 sentences max, no filler]

Cordialement,

User's request: ${sanitized}`;

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
  { command: "everyone", description: "Tag all members in the group" },
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
  {
    command: "reserve",
    description: "Setup meal reservation (private chat only)",
  },
  {
    command: "reserveedit",
    description: "Edit meal reservation profile",
  },
  {
    command: "reservestatus",
    description: "Show your meal reservation settings",
  },
  {
    command: "reservestop",
    description: "Disable auto meal reservation",
  },
  {
    command: "reservecancel",
    description: "Cancel current reservation setup",
  },
  {
    command: "reservehealth",
    description: "Admin: reservation system health snapshot",
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
  {
    command: "email",
    description: "Generate a formal French email from your description",
  },
  {
    command: "solve",
    description: "Solve an exercise — reply to a file or write the problem",
  },
  {
    command: "qcm",
    description: "Generate a QCM quiz on a topic",
  },
  {
    command: "wheel",
    description: "Spin a wheel — /wheel opt1, opt2, opt3",
  },
  {
    command: "wheeladd",
    description: "Add an option to the group wheel",
  },
  {
    command: "wheelremove",
    description: "Remove an option from the group wheel by index",
  },
  {
    command: "wheelshow",
    description: "Show saved wheel options for this group",
  },
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
    const normalizedCommand = normalizeBotCommand(sanitizedText);

    if (RESERVE_COMMANDS.has(normalizedCommand)) {
      await handleReserveCommand(normalizedCommand, chatId, userId, msg);
      return;
    }

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
      sanitizedText === "/everyone" ||
      sanitizedText === "/everyone@tagallesisbabot"
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

    if (
      sanitizedText === "/reservehealth" ||
      sanitizedText === "/reservehealth@tagallesisbabot"
    ) {
      if (ADMIN_USER_IDS.size === 0) {
        await bot.sendMessage(
          chatId,
          "Reservation health check is disabled because ADMIN_USER_IDS is not configured on the server.",
        );
        return;
      }

      if (!isAdminUser(userId)) {
        await bot.sendMessage(
          chatId,
          "You are not allowed to use this command.",
        );
        return;
      }

      await bot.sendChatAction(chatId, "typing");
      const snapshot = await getReservationHealthSnapshot();
      await bot.sendMessage(chatId, formatReservationHealth(snapshot));
      return;
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

    // /solve command
    if (
      sanitizedText.startsWith("/solve") ||
      sanitizedText.startsWith("/solve@tagallesisbabot")
    ) {
      const guide = sanitizedText
        .replace(/^\/solve(@tagallesisbabot)?\s*/, "")
        .trim();
      const replyMsg = msg.reply_to_message;
      const fileInfo = extractFileFromMessage(replyMsg);

      if (!fileInfo && !guide) {
        await bot.sendMessage(
          chatId,
          "📎 *How to use /solve:*\n\n• Reply to an image or PDF with `/solve` to solve it\n• Add a guide: `/solve solve in Python`\n• Or just write the problem: `/solve integrate x² from 0 to 1`",
          { parse_mode: "Markdown" },
        );
      } else {
        try {
          await bot.sendMessage(
            chatId,
            fileInfo
              ? "🔍 Downloading and analysing the file..."
              : "🧠 Solving...",
          );
          await bot.sendChatAction(chatId, "typing");

          let fileBase64 = null;
          let mimeType = null;

          if (fileInfo) {
            fileBase64 = await downloadTelegramFile(fileInfo.fileId);
            mimeType = fileInfo.mimeType;
          }

          const solution = await solveWithAI(
            guide || null,
            fileBase64,
            mimeType,
          );

          // Split long responses
          const MAX = 4000;
          if (solution.length <= MAX) {
            await bot.sendMessage(chatId, solution, { parse_mode: "Markdown" });
          } else {
            const parts = [];
            for (let i = 0; i < solution.length; i += MAX) {
              parts.push(solution.slice(i, i + MAX));
            }
            for (const part of parts) {
              await bot.sendMessage(chatId, part, { parse_mode: "Markdown" });
            }
          }
        } catch (error) {
          console.error("Solve command error:", error);
          const msg_err =
            error instanceof BotError && error.code === "QUOTA_EXCEEDED"
              ? "ولي غدوة وليدو"
              : "❌ Failed to solve. Make sure the file is an image or PDF and try again.";
          await bot.sendMessage(chatId, msg_err);
        }
      }
    }

    // /qcm command
    if (
      sanitizedText.startsWith("/qcm ") ||
      sanitizedText.startsWith("/qcm@tagallesisbabot ") ||
      sanitizedText === "/qcm" ||
      sanitizedText === "/qcm@tagallesisbabot"
    ) {
      const topic = sanitizedText
        .replace(/^\/qcm(@tagallesisbabot)?\s*/, "")
        .trim();

      if (!topic) {
        await bot.sendMessage(
          chatId,
          "📝 *How to use /qcm:*\n\nProvide a topic and the bot generates a 5-question QCM with hidden answers.\n\n*Examples:*\n• `/qcm algorithmique`\n• `/qcm bases de données relationnelles`\n• `/qcm photosynthèse`",
          { parse_mode: "Markdown" },
        );
      } else {
        try {
          await bot.sendChatAction(chatId, "typing");
          const qcm = await generateQCM(topic);
          // format spoilers from || || into HTML
          const formatted = formatGameMessage(qcm);
          await bot.sendMessage(
            chatId,
            `📝 <b>QCM — ${topic}</b>\n\n${formatted}`,
            { parse_mode: "HTML" },
          );
        } catch (error) {
          console.error("QCM command error:", error);
          await bot.sendMessage(
            chatId,
            "❌ Failed to generate QCM. Please try again.",
          );
        }
      }
    }

    // Email command
    if (
      sanitizedText.startsWith("/email ") ||
      sanitizedText.startsWith("/email@tagallesisbabot ")
    ) {
      const description = sanitizedText.replace(
        /^\/email(@tagallesisbabot)?\s+/,
        "",
      );
      if (description.trim()) {
        try {
          await bot.sendChatAction(chatId, "typing");
          const emailContent = await generateEmail(description);
          await bot.sendMessage(
            chatId,
            `📧 *Email generated:*\n\n${emailContent}`,
            {
              parse_mode: "Markdown",
            },
          );
        } catch (error) {
          console.error("Email command error:", error);
          await bot.sendMessage(
            chatId,
            "❌ **Error!** Could not generate the email. Please try again. 🔄",
            { parse_mode: "Markdown" },
          );
        }
      } else {
        await bot.sendMessage(
          chatId,
          "📧 *How to use /email:*\n\nDescribe your email in English or Arabic and the bot will write it in formal French.\n\n*Examples:*\n• `/email ask the professor to postpone the exam`\n• `/email request an appointment with the dean`\n• `/email طلب تمديد في تسليم التقرير`",
          { parse_mode: "Markdown" },
        );
      }
    } else if (
      sanitizedText === "/email" ||
      sanitizedText === "/email@tagallesisbabot"
    ) {
      await bot.sendMessage(
        chatId,
        "📧 *How to use /email:*\n\nDescribe your email in English or Arabic and the bot will write it in formal French.\n\n*Examples:*\n• `/email ask the professor to postpone the exam`\n• `/email request an appointment with the dean`\n• `/email طلب تمديد في تسليم التقرير`",
        { parse_mode: "Markdown" },
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

    // /wheel command
    if (
      sanitizedText.startsWith("/wheel ") ||
      sanitizedText.startsWith("/wheel@tagallesisbabot ") ||
      sanitizedText === "/wheel" ||
      sanitizedText === "/wheel@tagallesisbabot"
    ) {
      const inlineOptions = sanitizedText
        .replace(/^\/wheel(@tagallesisbabot)?\s*/, "")
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o.length > 0);

      if (inlineOptions.length >= 2) {
        await spinWheel(chatId, inlineOptions);
      } else if (inlineOptions.length === 1) {
        await bot.sendMessage(
          chatId,
          "⚠️ *Need at least 2 options to spin!*\n\n*Example:* `/wheel pizza, sushi, burgers`",
          { parse_mode: "Markdown" },
        );
      } else {
        // Fall back to saved group wheel
        const wheelData = await getWheelOptions(chatId);
        if (wheelData.options.length >= 2) {
          await spinWheel(chatId, wheelData.options);
        } else {
          await bot.sendMessage(
            chatId,
            "🎡 *How to use /wheel:*\n\n• *Inline:* `/wheel pizza, sushi, burgers`\n• *Saved wheel:* add options with `/wheeladd option`, then just `/wheel`\n\n*Need at least 2 options to spin!*",
            { parse_mode: "Markdown" },
          );
        }
      }
    }

    // /wheeladd
    if (
      sanitizedText.startsWith("/wheeladd ") ||
      sanitizedText.startsWith("/wheeladd@tagallesisbabot ")
    ) {
      const option = sanitizedText
        .replace(/^\/wheeladd(@tagallesisbabot)?\s+/, "")
        .trim();
      if (option) {
        const wheelData = await getWheelOptions(chatId);
        if (wheelData.options.includes(option)) {
          await bot.sendMessage(
            chatId,
            `ℹ️ *"${option}"* is already in the wheel!`,
            { parse_mode: "Markdown" },
          );
        } else {
          wheelData.options.push(option);
          await updateWheelOptions(chatId, wheelData.options);
          await bot.sendMessage(
            chatId,
            `✅ Added *"${option}"* to the wheel! *(${wheelData.options.length} options total)*`,
            { parse_mode: "Markdown" },
          );
        }
      }
    }

    // /wheelremove
    if (
      sanitizedText.startsWith("/wheelremove ") ||
      sanitizedText.startsWith("/wheelremove@tagallesisbabot ")
    ) {
      const wheelData = await getWheelOptions(chatId);
      const indexStr = sanitizedText
        .replace(/^\/wheelremove(@tagallesisbabot)?\s+/, "")
        .trim();
      const index = parseInt(indexStr, 10) - 1;
      if (isNaN(index) || index < 0 || index >= wheelData.options.length) {
        await bot.sendMessage(
          chatId,
          `❌ Invalid index. Use \`/wheelshow\` to see the list.`,
          { parse_mode: "Markdown" },
        );
      } else {
        const removed = wheelData.options.splice(index, 1)[0];
        await updateWheelOptions(chatId, wheelData.options);
        await bot.sendMessage(
          chatId,
          `🗑️ Removed *"${removed}"* from the wheel.`,
          { parse_mode: "Markdown" },
        );
      }
    }

    // /wheelshow
    if (
      sanitizedText === "/wheelshow" ||
      sanitizedText === "/wheelshow@tagallesisbabot"
    ) {
      const wheelData = await getWheelOptions(chatId);
      if (wheelData.options.length === 0) {
        await bot.sendMessage(
          chatId,
          "📭 *No saved wheel options yet.*\n\nUse `/wheeladd option` to add some!",
          { parse_mode: "Markdown" },
        );
      } else {
        const list = wheelData.options
          .map((o, i) => `${i + 1}. ${o}`)
          .join("\n");
        await bot.sendMessage(
          chatId,
          `🎡 *Saved wheel options (${wheelData.options.length}):*\n\n${list}\n\nSpin with \`/wheel\` or remove one with \`/wheelremove {index}\``,
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

    // Handle inline keyboard callbacks
    const callbackQuery = body.callback_query;
    if (callbackQuery) {
      if (callbackQuery.data?.startsWith("reserve:")) {
        await handleReserveCallback(callbackQuery);
      } else if (callbackQuery.data?.startsWith("game_")) {
        await handleGameCallback(callbackQuery);
      } else {
        try {
          await bot.answerCallbackQuery(callbackQuery.id);
        } catch (_) {
          // ignore callback timeout
        }
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const msg = body.message;

    // Auto-register new members when they join the group
    if (msg && msg.new_chat_members) {
      const chatId = msg.chat.id;
      const groupData = await getGroupMembers(chatId);
      let changed = false;
      for (const newMember of msg.new_chat_members) {
        if (newMember.is_bot) continue;
        if (!groupData.members.some((m) => m.id === newMember.id)) {
          groupData.members.push({
            id: newMember.id,
            first_name: newMember.first_name,
          });
          changed = true;
        }
      }
      if (changed) await updateGroupMembers(chatId, groupData.members);
    }

    if (!msg || !msg.text) {
      return new Response(
        JSON.stringify({ message: "No message or text to process" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = sanitizeInput(msg.text);

    // Silently auto-register sender if not already in DB
    if (msg.from && !msg.from.is_bot) {
      const groupData = await getGroupMembers(chatId);
      if (!groupData.members.some((m) => m.id === userId)) {
        groupData.members.push({ id: userId, first_name: msg.from.first_name });
        await updateGroupMembers(chatId, groupData.members);
      }
    }

    // Handle /reserve state machine text replies first
    const reserveFlowHandled = await handleReserveFlowText(msg, text);
    if (reserveFlowHandled) {
      return new Response(
        JSON.stringify({ message: "Reserve flow message processed" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

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

        // Check if replying to a file — pass it to Gemini as multimodal
        const replyFileInfo = extractFileFromMessage(msg.reply_to_message);
        let aiResponse;
        if (replyFileInfo) {
          try {
            const fileBase64 = await downloadTelegramFile(replyFileInfo.fileId);
            const filePrompt = `${replyContext ? `[Replying to a file${replyContext ? ` with caption: "${replyContext}"` : ""}]\n` : ""}${question}`;
            aiResponse = await callGeminiAPIMultimodal(
              filePrompt,
              fileBase64,
              replyFileInfo.mimeType,
            );
          } catch (e) {
            console.error(
              "File fetch for /ask failed, falling back to text",
              e,
            );
            aiResponse = await generateAIResponse(
              question,
              chatId,
              userId,
              replyContext,
            );
          }
        } else {
          aiResponse = await generateAIResponse(
            question,
            chatId,
            userId,
            replyContext,
          );
        }

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
            )}\`\n\nPlease provide valid indexes between 1 and ${remindersData.reminders.length
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
