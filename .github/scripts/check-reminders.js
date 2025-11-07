// Netlify serverless function to check and send due reminders
// Triggered by external cron service (cron-job.org)

import TelegramBot from "node-telegram-bot-api";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

// Get directory paths for ES modules
const __filename_local = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename_local);

const REMINDERS_FILE = path.join(__dirname_local, "../../data/reminders.json");

// Storage functions (inline for Netlify function)
async function ensureDataFile() {
  try {
    await fs.access(REMINDERS_FILE);
  } catch {
    const dataDir = path.dirname(REMINDERS_FILE);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(REMINDERS_FILE, "[]");
  }
}

async function getRemindersForToday(dateString) {
  await ensureDataFile();
  
  try {
    const data = await fs.readFile(REMINDERS_FILE, "utf-8");
    const allReminders = JSON.parse(data);
    
    return allReminders.filter(
      (reminder) => reminder.date === dateString && reminder.sent === false
    );
  } catch (error) {
    console.error("Error reading reminders:", error);
    return [];
  }
}

async function markReminderAsSent(reminderId) {
  await ensureDataFile();
  
  try {
    const data = await fs.readFile(REMINDERS_FILE, "utf-8");
    const allReminders = JSON.parse(data);
    
    const reminder = allReminders.find((r) => r.id === reminderId);
    if (reminder) {
      reminder.sent = true;
      reminder.sentAt = new Date().toISOString();
      
      await fs.writeFile(REMINDERS_FILE, JSON.stringify(allReminders, null, 2));
      console.log(`Reminder ${reminderId} marked as sent`);
      return true;
    }
    
    console.warn(`Reminder ${reminderId} not found`);
    return false;
  } catch (error) {
    console.error("Error marking reminder as sent:", error);
    return false;
  }
}

export async function handler(event, context) {
  console.log("Check-reminders function triggered at:", new Date().toISOString());

  // Security: Validate token
  const token = event.queryStringParameters?.token;
  if (!token || token !== process.env.CRON_SECRET) {
    console.error("Unauthorized access attempt");
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  try {
    // Initialize bot
    const bot = new TelegramBot(process.env.TOKEN2);

    // Get today's date in YYYY-MM-DD format (UTC)
    const today = new Date().toISOString().split("T")[0];
    console.log("Checking reminders for date:", today);

    // Get unsent reminders for today
    const reminders = await getRemindersForToday(today);
    console.log(`Found ${reminders.length} reminders to send`);

    let sentCount = 0;
    let failedCount = 0;

    // Send each reminder
    for (const reminder of reminders) {
      try {
        await bot.sendMessage(reminder.chatId, `🔔 *Reminder*\n\n${reminder.message}`, {
          parse_mode: "Markdown",
        });

        // Mark as sent
        await markReminderAsSent(reminder.id);
        sentCount++;
        console.log(`Sent reminder ${reminder.id} to chat ${reminder.chatId}`);
      } catch (error) {
        failedCount++;
        console.error(`Failed to send reminder ${reminder.id}:`, error.message);
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        checked: new Date().toISOString(),
        totalReminders: reminders.length,
        sent: sentCount,
        failed: failedCount,
      }),
    };
  } catch (error) {
    console.error("Error in check-reminders function:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        message: error.message,
      }),
    };
  }
}
