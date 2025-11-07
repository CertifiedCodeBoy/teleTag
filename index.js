import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import { addReminder, getUserReminders, deleteReminder } from "./utils/storage.js";

dotenv.config();

const bot = new TelegramBot(process.env.TOKEN2, { polling: true });

const commands = [
  { command: "setreminder", description: "Set a reminder (format: /setreminder YYYY-MM-DD Your message)" },
  { command: "reminders", description: "View all your active reminders" },
  { command: "deletereminder", description: "Delete a reminder (format: /deletereminder reminder_id)" },
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

// Helper function to validate date format
function isValidDate(dateString) {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;
  
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date);
}

// Command: /setreminder
bot.onText(/\/setreminder(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || msg.from.first_name;
  
  if (!match[1]) {
    return bot.sendMessage(
      chatId,
      "❌ *Usage:* `/setreminder YYYY-MM-DD Your reminder message`\n\n" +
      "*Example:* `/setreminder 2025-12-25 Buy Christmas gifts`",
      { parse_mode: "Markdown" }
    );
  }
  
  const input = match[1].trim();
  const parts = input.split(" ");
  
  if (parts.length < 2) {
    return bot.sendMessage(
      chatId,
      "❌ Please provide both a date and a message.\n\n" +
      "*Example:* `/setreminder 2025-12-25 Buy Christmas gifts`",
      { parse_mode: "Markdown" }
    );
  }
  
  const date = parts[0];
  const message = parts.slice(1).join(" ");
  
  // Validate date format
  if (!isValidDate(date)) {
    return bot.sendMessage(
      chatId,
      "❌ Invalid date format. Please use *YYYY-MM-DD*\n\n" +
      "*Example:* `/setreminder 2025-12-25 Buy Christmas gifts`",
      { parse_mode: "Markdown" }
    );
  }
  
  // Check if date is in the past
  const reminderDate = new Date(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  if (reminderDate < today) {
    return bot.sendMessage(
      chatId,
      "❌ Cannot set reminder for a past date. Please choose a future date.",
      { parse_mode: "Markdown" }
    );
  }
  
  try {
    const reminder = await addReminder(chatId, userId, username, message, date);
    
    bot.sendMessage(
      chatId,
      `✅ *Reminder set successfully!*\n\n` +
      `📅 Date: ${date}\n` +
      `💬 Message: ${message}\n` +
      `🆔 ID: \`${reminder.id}\`\n\n` +
      `You'll receive this reminder at midnight (00:00 UTC) on ${date}.`,
      { parse_mode: "Markdown" }
    );
  } catch (error) {
    console.error("Error setting reminder:", error);
    bot.sendMessage(
      chatId,
      "❌ Failed to set reminder. Please try again later.",
      { parse_mode: "Markdown" }
    );
  }
});

// Command: /reminders
bot.onText(/\/reminders/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  try {
    const reminders = await getUserReminders(userId);
    
    if (reminders.length === 0) {
      return bot.sendMessage(
        chatId,
        "📭 You have no active reminders.\n\n" +
        "Use `/setreminder YYYY-MM-DD message` to create one!",
        { parse_mode: "Markdown" }
      );
    }
    
    // Sort reminders by date
    reminders.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    let message = `📋 *Your Active Reminders* (${reminders.length})\n\n`;
    
    reminders.forEach((reminder, index) => {
      message += `*${index + 1}.* 📅 ${reminder.date}\n`;
      message += `   💬 ${reminder.message}\n`;
      message += `   🆔 \`${reminder.id}\`\n\n`;
    });
    
    message += "\n_To delete a reminder, use:_\n`/deletereminder reminder_id`";
    
    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  } catch (error) {
    console.error("Error getting reminders:", error);
    bot.sendMessage(
      chatId,
      "❌ Failed to retrieve reminders. Please try again later.",
      { parse_mode: "Markdown" }
    );
  }
});

// Command: /deletereminder
bot.onText(/\/deletereminder(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  if (!match[1]) {
    return bot.sendMessage(
      chatId,
      "❌ *Usage:* `/deletereminder reminder_id`\n\n" +
      "Use `/reminders` to see your reminder IDs.",
      { parse_mode: "Markdown" }
    );
  }
  
  const reminderId = match[1].trim();
  
  try {
    const deleted = await deleteReminder(reminderId, userId);
    
    if (deleted) {
      bot.sendMessage(
        chatId,
        `✅ Reminder deleted successfully!\n\n🆔 \`${reminderId}\``,
        { parse_mode: "Markdown" }
      );
    } else {
      bot.sendMessage(
        chatId,
        "❌ Reminder not found or you don't have permission to delete it.",
        { parse_mode: "Markdown" }
      );
    }
  } catch (error) {
    console.error("Error deleting reminder:", error);
    bot.sendMessage(
      chatId,
      "❌ Failed to delete reminder. Please try again later.",
      { parse_mode: "Markdown" }
    );
  }
});

// Log all messages
bot.on("message", async (msg) => {
  console.log(`Received message: ${msg.text} from ${msg.from.username || msg.from.id}`);
});

console.log("TeleTag bot is running with automated reminder system...");
