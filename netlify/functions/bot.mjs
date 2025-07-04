import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const bot = new TelegramBot(process.env.TOKEN);

const mongoClient = new MongoClient(process.env.MONGO_URI);
let db;

// AI Helper Functions - Updated to match your working GeminiService
async function callGeminiAPI(prompt) {
  try {
    // Track usage
    trackAPIUsage();
    
    // Check if API key exists
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY not found in environment variables');
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
              parts: [
                {
                  text: prompt,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            topP: 0.9,
            maxOutputTokens: 500,
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
      
      // Check if it's a quota exceeded error
      if (response.status === 429 || errorData.error?.message?.includes("quota")) {
        throw new Error("QUOTA_EXCEEDED");
      }
      
      throw new Error(
        `Gemini API error: ${response.status} - ${
          errorData.error?.message || "Unknown error"
        }`
      );
    }

    const data = await response.json();
    
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error("No response generated from Gemini API");
    }

    const responseText = data.candidates[0].content.parts[0].text;
    return responseText;

  } catch (error) {
    console.error("Gemini API Error:", error);
    
    if (error.message === "QUOTA_EXCEEDED") {
      return "⚠️ API quota exceeded! You've reached your free tier limit. Please try again tomorrow or upgrade your plan.";
    } else if (error.message.includes("API key")) {
      return "Invalid Gemini API key. Please check your configuration.";
    } else if (error.message.includes("network")) {
      return "Network error connecting to Gemini API. Please check your internet connection.";
    }
    
    return "Sorry, I'm having trouble processing your request right now. Please try again later.";
  }
}

async function connectToDatabase() {
  if (!db) {
    try {
      await mongoClient.connect();
      db = mongoClient.db("teleTag");
      console.log("Connected to MongoDB");
    } catch (err) {
      console.error("Error connecting to MongoDB", err);
      throw err;
    }
  }
  return db;
}

// Ensure database is connected before using collections
const membersCollection = async () => {
  await connectToDatabase();
  return db.collection("groupMembers");
};
const helpersCollection = async () => {
  await connectToDatabase();
  return db.collection("helpers");
};
const remindersCollection = async () => {
  await connectToDatabase();
  return db.collection("reminders");
};
const aiConversationsCollection = async () => {
  await connectToDatabase();
  return db.collection("aiConversations");
};

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
    await connectToDatabase();
    
    const alreadysetcommands = await bot.getMyCommands();

    if (alreadysetcommands.length !== commands.length) {
      await bot.setMyCommands(commands);
      console.log("Bot commands set successfully");
    } else {
      console.log("Commands already set");
    }
  } catch (error) {
    console.error("Error initializing bot:", error);
  }
}

// Initialize bot
initializeBot();

// AI Helper Functions
async function getAIConversation(chatId, userId) {
  const collection = await aiConversationsCollection();
  const conversation = await collection.findOne({
    chatId,
    userId,
  });
  return conversation?.messages || [];
}

async function saveAIConversation(chatId, userId, messages) {
  const collection = await aiConversationsCollection();
  await collection.updateOne(
    { chatId, userId },
    { $set: { messages, lastUpdated: new Date() } },
    { upsert: true }
  );
}

async function generateAIResponse(prompt, chatId, userId) {
  try {
    // Get conversation history
    const history = await getAIConversation(chatId, userId);

    // Build context with history
    let fullPrompt = "You are a helpful AI assistant in a Telegram group chat. ";

    if (history.length > 0) {
      fullPrompt += "Previous conversation:\n";
      history.slice(-10).forEach((msg) => {
        fullPrompt += `${msg.role}: ${msg.content}\n`;
      });
      fullPrompt += "\n";
    }

    fullPrompt += `User: ${prompt}`;

    const aiResponse = await callGeminiAPI(fullPrompt);

    // Only save conversation if we got a valid response
    if (aiResponse && !aiResponse.includes("Sorry, I'm having trouble")) {
      // Update conversation history
      const newMessages = [
        ...history,
        { role: "user", content: prompt, timestamp: new Date() },
        { role: "assistant", content: aiResponse, timestamp: new Date() },
      ].slice(-20); // Keep last 20 messages

      await saveAIConversation(chatId, userId, newMessages);
    }

    return aiResponse;
  } catch (error) {
    console.error("AI Error:", error);
    return "Sorry, I'm having trouble processing your request right now.";
  }
}

async function translateText(text) {
  const prompt = `Translate the following text to English. If it's already in English, translate to Arabic. Only provide the translation:\n\n${text}`;
  return await callGeminiAPI(prompt);
}

async function summarizeText(text) {
  const prompt = `Summarize the following text in a concise way:\n\n${text}`;
  return await callGeminiAPI(prompt);
}

// Helper Functions
async function getGroupMembers(chatId) {
  const collection = await membersCollection();
  const groupData = await collection.findOne({ chatId });
  return groupData || { chatId, members: [] };
}

async function updateGroupMembers(chatId, members) {
  const collection = await membersCollection();
  return collection.updateOne(
    { chatId },
    { $set: { members } },
    { upsert: true }
  );
}

async function getHelpers(chatId) {
  const collection = await helpersCollection();
  const helpersData = await collection.findOne({ chatId });
  return helpersData || { chatId, helpers: [] };
}

async function updateHelpers(chatId, helpers) {
  const collection = await helpersCollection();
  return collection.updateOne(
    { chatId },
    { $set: { helpers } },
    { upsert: true }
  );
}

async function getReminders(chatId) {
  const collection = await remindersCollection();
  const remindersData = await collection.findOne({ chatId });
  return remindersData || { chatId, reminders: [] };
}

async function updateReminders(chatId, reminders) {
  const collection = await remindersCollection();
  return collection.updateOne(
    { chatId },
    { $set: { reminders } },
    { upsert: true }
  );
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

function isValidDate(date) {
  const dateParts = date.split("-");
  if (dateParts.length !== 3) return false;
  const year = parseInt(dateParts[0]);
  const month = parseInt(dateParts[1]);
  const day = parseInt(dateParts[2]);

  if (isNaN(year) || isNaN(month) || isNaN(day)) return false;

  const currentDate = new Date();
  const inputDate = new Date(year, month - 1, day);

  if (inputDate <= currentDate) return false;

  if (inputDate.getMonth() !== month - 1) return false;

  return true;
}

let dailyUsageCounter = 0;
let lastResetDate = new Date().toDateString();

function trackAPIUsage() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyUsageCounter = 0;
    lastResetDate = today;
  }
  dailyUsageCounter++;
}

// Add this function to check API status
async function checkGeminiAPIStatus() {
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      throw new Error(`API Status Check Failed: ${response.status}`);
    }

    const data = await response.json();
    return {
      status: "active",
      models: data.models?.length || 0,
      message: "API key is working correctly"
    };
  } catch (error) {
    console.error("API Status Check Error:", error);
    return {
      status: "error",
      models: 0,
      message: error.message
    };
  }
}

async function staticCommands(text, chatId, userId, msg) {
  if (text === "/start" || text === "/start@tagallesisbabot") {
    await bot.sendMessage(
      chatId,
      "Hello! I'm your AI-powered group assistant. Use /join to join the group or /ask to chat with me!"
    );
  }

  if (text === "/join" || text === "/join@tagallesisbabot") {
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

  if (text === "/leave" || text === "/leave@tagallesisbabot") {
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

  if (text === "/showmembers" || text === "/showmembers@tagallesisbabot") {
    const groupData = await getGroupMembers(chatId);
    const membersMessage = groupData.members.length
      ? groupData.members.map((member) => member.first_name).join(", ")
      : "No members found.";
    await bot.sendMessage(chatId, membersMessage);
  }

  if (text === "/mentionall" || text === "/mentionall@tagallesisbabot") {
    const groupData = await getGroupMembers(chatId);
    const mentions = groupData.members.map(
      (member) => `[${member.first_name}](tg://user?id=${member.id})`
    );

    const message = mentions.length
      ? mentions.join(" ")
      : "No members to mention.";
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  }

  if (text === "/addtohelp" || text === "/addtohelp@tagallesisbabot") {
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

  if (text === "/showhelpers" || text === "/showhelpers@tagallesisbabot") {
    const helpersData = await getHelpers(chatId);
    const helpersMessage = helpersData.helpers.length
      ? helpersData.helpers.map((helper) => helper.first_name).join(", ")
      : "No helpers found.";
    await bot.sendMessage(chatId, helpersMessage);
  }

  if (text === "/leavehelpers" || text === "/leavehelpers@tagallesisbabot") {
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

  if (text === "/help" || text === "/help@tagallesisbabot") {
    const helpersData = await getHelpers(chatId);
    const mentions = helpersData.helpers.map(
      (helper) => `[${helper.first_name}](tg://user?id=${helper.id})`
    );
    const message = mentions.length
      ? mentions.join(" ")
      : "No helpers available right now.";
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  }

  if (text === "/reminders" || text === "/reminders@tagallesisbabot") {
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
    text === "/clearreminders" ||
    text === "/clearreminders@tagallesisbabot"
  ) {
    await updateReminders(chatId, []);
    await bot.sendMessage(chatId, "Reminders cleared");
  }

  // AI Commands
  if (text === "/clearai" || text === "/clearai@tagallesisbabot") {
    const collection = await aiConversationsCollection();
    await collection.deleteOne({ chatId, userId });
    await bot.sendMessage(chatId, "🤖 AI conversation history cleared!");
  }

  if (text === "/translate" || text === "/translate@tagallesisbabot") {
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

  if (text === "/summarize" || text === "/summarize@tagallesisbabot") {
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

  if (text === "/reset" || text === "/reset@tagallesisbabot") {
    await updateGroupMembers(chatId, []);
    await updateHelpers(chatId, []);
    await updateReminders(chatId, []);
    const collection = await aiConversationsCollection();
    await collection.deleteMany({ chatId });
    await bot.sendMessage(
      chatId,
      "Bot has been completely reset (including AI conversations)."
    );
  }

  // Add credits command
  if (text === "/credits" || text === "/credits@tagallesisbabot") {
    try {
      await bot.sendChatAction(chatId, "typing");
      
      const apiStatus = await checkGeminiAPIStatus();
      
      const creditsMessage = `
📊 **API Usage Information**

🔑 **API Status**: ${apiStatus.status === 'active' ? '✅ Active' : '❌ Error'}
🤖 **Available Models**: ${apiStatus.models}
📈 **Today's Requests**: ${dailyUsageCounter}

📋 **Free Tier Limits** (Gemini):
• 15 requests per minute
• 1,500 requests per day
• 1 million tokens per day

💡 **Tips to Monitor Usage**:
• Check Google AI Studio Console
• Visit: https://aistudio.google.com/
• Go to "API Keys" section for usage stats

⚠️ **Important**: This bot tracks requests locally (resets daily). For accurate quota info, check Google AI Studio.

${apiStatus.message}
      `;
      
      await bot.sendMessage(chatId, creditsMessage, { parse_mode: "Markdown" });
    } catch (error) {
      console.error("Credits command error:", error);
      await bot.sendMessage(chatId, "❌ Unable to fetch API information right now.");
    }
  }
}

export default async function handler(event) {
  try {
    // Ensure database is connected at the start of each request
    await connectToDatabase();
    
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
    const text = msg.text;

    // Handle static commands first
    await staticCommands(text, chatId, userId, msg);

    // AI Ask Command
    if (text.startsWith("/ask ") || text.startsWith("/ask@tagallesisbabot ")) {
      const question = text.replace(/^\/ask(@tagallesisbabot)?\s+/, "");
      if (question.trim()) {
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

    // Smart AI responses for questions or mentions
    if (
      !text.startsWith("/") &&
      (text.includes("?") ||
        text.toLowerCase().includes("bot") ||
        text.includes("@tagallesisbabot") ||
        msg.reply_to_message?.from?.username === "tagallesisbabot")
    ) {
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
    console.error("Error:", error);

    return new Response(
      JSON.stringify({
        message: "Internal Server Error",
        error: error.message,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
