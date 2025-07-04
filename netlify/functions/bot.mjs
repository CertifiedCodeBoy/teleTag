import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const bot = new TelegramBot(process.env.TOKEN);

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-pro" });

const mongoClient = new MongoClient(process.env.MONGO_URI);
let db;

// AI Chat History Cache
const chatHistories = new Map();

async function connectToDatabase() {
  if (!db) {
    try {
      await mongoClient.connect();
      db = mongoClient.db("teleTag");
      console.log("Connected to MongoDB");
    } catch (err) {
      console.error("Error connecting to MongoDB", err);
    }
  }
}

async function exampleFunction() {
  await connectToDatabase();
}

exampleFunction();

const membersCollection = () => {
  if (!db) throw new Error("Database not initialized");
  return db.collection("groupMembers");
};
const helpersCollection = () => {
  if (!db) throw new Error("Database not initialized");
  return db.collection("helpers");
};
const remindersCollection = () => {
  if (!db) throw new Error("Database not initialized");
  return db.collection("reminders");
};
const conversationsCollection = () => {
  if (!db) throw new Error("Database not initialized");
  return db.collection("conversations");
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
  { command: "ai", description: "Chat with AI assistant" },
  { command: "aihelp", description: "Get AI help for group questions" },
  { command: "summarize", description: "Summarize conversation (reply to messages)" },
  { command: "translate", description: "Translate text (reply to message)" },
  { command: "clearai", description: "Clear AI conversation history" },
];

const alreadysetcommands = await bot.getMyCommands();

if (alreadysetcommands.length !== commands.length) {
  bot
    .setMyCommands(commands)
    .then(() => {
      console.log("Bot commands set successfully");
    })
    .catch((error) => {
      console.error("Error setting bot commands:", error);
    });
} else {
  console.log("Commands already set");
}

// AI Helper Functions
async function getChatHistory(chatId, userId) {
  const key = `${chatId}_${userId}`;
  if (chatHistories.has(key)) {
    return chatHistories.get(key);
  }
  
  const historyData = await conversationsCollection().findOne({ 
    chatId, 
    userId 
  });
  
  const history = historyData?.history || [];
  chatHistories.set(key, history);
  return history;
}

async function saveChatHistory(chatId, userId, history) {
  const key = `${chatId}_${userId}`;
  chatHistories.set(key, history);
  
  await conversationsCollection().updateOne(
    { chatId, userId },
    { $set: { history, lastUpdated: new Date() } },
    { upsert: true }
  );
}

async function generateAIResponse(prompt, chatId, userId, context = "") {
  try {
    const history = await getChatHistory(chatId, userId);
    
    let fullPrompt = `You are a helpful AI assistant in a Telegram group chat. `;
    if (context) {
      fullPrompt += `Context: ${context}\n\n`;
    }
    
    // Add conversation history
    if (history.length > 0) {
      fullPrompt += "Previous conversation:\n";
      history.slice(-10).forEach(msg => {
        fullPrompt += `${msg.role}: ${msg.content}\n`;
      });
      fullPrompt += "\n";
    }
    
    fullPrompt += `User: ${prompt}`;
    
    const result = await model.generateContent(fullPrompt);
    const response = result.response;
    const aiResponse = response.text();
    
    // Update history
    const newHistory = [
      ...history,
      { role: "user", content: prompt, timestamp: new Date() },
      { role: "assistant", content: aiResponse, timestamp: new Date() }
    ].slice(-20); // Keep last 20 messages
    
    await saveChatHistory(chatId, userId, newHistory);
    
    return aiResponse;
  } catch (error) {
    console.error("AI Error:", error);
    return "Sorry, I'm having trouble processing your request right now. Please try again later.";
  }
}

async function translateText(text, targetLang = "auto") {
  try {
    const prompt = `Translate the following text to ${targetLang === "auto" ? "English" : targetLang}. If it's already in ${targetLang === "auto" ? "English" : targetLang}, translate to Arabic. Only provide the translation, no explanations:\n\n${text}`;
    
    const result = await model.generateContent(prompt);
    const response = result.response;
    return response.text();
  } catch (error) {
    console.error("Translation Error:", error);
    return "Sorry, I couldn't translate that text.";
  }
}

async function summarizeMessages(messages) {
  try {
    const prompt = `Summarize the following conversation in a concise way, highlighting key points and decisions:\n\n${messages}`;
    
    const result = await model.generateContent(prompt);
    const response = result.response;
    return response.text();
  } catch (error) {
    console.error("Summarization Error:", error);
    return "Sorry, I couldn't summarize those messages.";
  }
}

// Helper Functions (existing)
async function getGroupMembers(chatId) {
  const groupData = await membersCollection().findOne({ chatId });
  return groupData || { chatId, members: [] };
}

async function updateGroupMembers(chatId, members) {
  return membersCollection().updateOne(
    { chatId },
    { $set: { members } },
    { upsert: true }
  );
}

async function getHelpers(chatId) {
  const helpersData = await helpersCollection().findOne({ chatId });
  return helpersData || { chatId, helpers: [] };
}

async function updateHelpers(chatId, helpers) {
  return helpersCollection().updateOne(
    { chatId },
    { $set: { helpers } },
    { upsert: true }
  );
}

async function getReminders(chatId) {
  const remindersData = await remindersCollection().findOne({ chatId });
  return remindersData || { chatId, reminders: [] };
}

async function updateReminders(chatId, reminders) {
  return remindersCollection().updateOne(
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

async function staticCommands(text, chatId, userId, msg) {
  // Existing commands
  if (text === "/start" || text === "/start@tagallesisbabot") {
    await bot.sendMessage(chatId, "Hello! I'm your AI-powered group assistant. Use /join to join the group or /ai to chat with me!");
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
    const key = `${chatId}_${userId}`;
    chatHistories.delete(key);
    await conversationsCollection().deleteOne({ chatId, userId });
    await bot.sendMessage(chatId, "AI conversation history cleared!");
  }

  if (text === "/aihelp" || text === "/aihelp@tagallesisbabot") {
    const groupData = await getGroupMembers(chatId);
    const helpersData = await getHelpers(chatId);
    
    const context = `This is a group with ${groupData.members.length} members and ${helpersData.helpers.length} helpers. The user is asking for general help.`;
    
    const aiResponse = await generateAIResponse(
      "I need help with something in this group. Can you assist me?",
      chatId,
      userId,
      context
    );
    
    await bot.sendMessage(chatId, `🤖 AI Assistant: ${aiResponse}`);
  }

  if (text === "/translate" || text === "/translate@tagallesisbabot") {
    if (msg.reply_to_message && msg.reply_to_message.text) {
      const translation = await translateText(msg.reply_to_message.text);
      await bot.sendMessage(chatId, `🌐 Translation: ${translation}`);
    } else {
      await bot.sendMessage(chatId, "Please reply to a message to translate it.");
    }
  }

  if (text === "/summarize" || text === "/summarize@tagallesisbabot") {
    if (msg.reply_to_message && msg.reply_to_message.text) {
      // Get recent messages for context
      const recentMessages = `Recent message: ${msg.reply_to_message.text}`;
      const summary = await summarizeMessages(recentMessages);
      await bot.sendMessage(chatId, `📝 Summary: ${summary}`);
    } else {
      await bot.sendMessage(chatId, "Please reply to a message to summarize the conversation.");
    }
  }

  if (text === "/reset" || text === "/reset@tagallesisbabot") {
    await updateGroupMembers(chatId, []);
    await updateHelpers(chatId, []);
    await updateReminders(chatId, []);
    // Clear AI conversations
    await conversationsCollection().deleteMany({ chatId });
    chatHistories.clear();
    await bot.sendMessage(chatId, "Bot has been reset completely (including AI conversations).");
  }
}

export default async function handler(event, res) {
  try {
    // const bodyString = await readStream(event.body);
    const bodyString = event.body;

    // const body = JSON.parse(bodyString);
    const body = bodyString;


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

    // AI Chat Handler
    if (text.startsWith("/ai ") || text.startsWith("/ai@tagallesisbabot ")) {
      const aiQuery = text.replace(/^\/ai(@tagallesisbabot)?\s+/, "");
      if (aiQuery.trim()) {
        const aiResponse = await generateAIResponse(aiQuery, chatId, userId);
        await bot.sendMessage(chatId, `🤖 ${aiResponse}`);
      } else {
        await bot.sendMessage(chatId, "Please provide a question or message after /ai. Example: /ai What's the weather like?");
      }
    }

    // Smart AI Detection - respond to messages mentioning the bot or asking questions
    if (!text.startsWith("/") && (
      text.toLowerCase().includes("bot") || 
      text.includes("@tagallesisbabot") ||
      text.includes("?") ||
      msg.reply_to_message?.from?.username === "tagallesisbabot"
    )) {
      const groupData = await getGroupMembers(chatId);
      const context = `Group context: ${groupData.members.length} members. User ${msg.from.first_name} is asking.`;
      
      const aiResponse = await generateAIResponse(text, chatId, userId, context);
      await bot.sendMessage(chatId, `🤖 ${aiResponse}`);
    }

    // Reminder system (existing logic)
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

    res.status(200).send("OK");
    // return new Response(
    //   JSON.stringify({ message: "Message processed successfully" }),
    //   { status: 200, headers: { "Content-Type": "application/json" } }
    // );

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
