// GitHub Actions backup script to check and send due reminders
// Runs independently of Netlify function for redundancy

import TelegramBot from "node-telegram-bot-api";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get bot token from environment
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN not found in environment");
  process.exit(1);
}

// Storage functions (simplified for GitHub Actions)
async function getRemindersForToday(dateString) {
  try {
    const remindersPath = path.join(__dirname, "../../data/reminders.json");
    const data = await fs.readFile(remindersPath, "utf-8");
    const allReminders = JSON.parse(data);
    
    // Filter for today's unsent reminders
    return allReminders.filter(
      (r) => r.date === dateString && r.sent === false
    );
  } catch (error) {
    console.error("Error reading reminders:", error.message);
    return [];
  }
}

async function markReminderAsSent(reminderId) {
  try {
    const remindersPath = path.join(__dirname, "../../data/reminders.json");
    const data = await fs.readFile(remindersPath, "utf-8");
    const allReminders = JSON.parse(data);
    
    // Find and update reminder
    const reminder = allReminders.find((r) => r.id === reminderId);
    if (reminder) {
      reminder.sent = true;
      reminder.sentAt = new Date().toISOString();
    }
    
    // Save back to file
    await fs.writeFile(remindersPath, JSON.stringify(allReminders, null, 2));
    console.log(`Marked reminder ${reminderId} as sent`);
  } catch (error) {
    console.error("Error marking reminder as sent:", error.message);
  }
}

// Main execution
async function main() {
  console.log("GitHub Actions reminder checker started at:", new Date().toISOString());

  try {
    const bot = new TelegramBot(BOT_TOKEN);

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
        console.log(`✓ Sent reminder ${reminder.id} to chat ${reminder.chatId}`);
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch (error) {
        failedCount++;
        console.error(`✗ Failed to send reminder ${reminder.id}:`, error.message);
      }
    }

    console.log("\n=== Summary ===");
    console.log(`Total reminders: ${reminders.length}`);
    console.log(`Successfully sent: ${sentCount}`);
    console.log(`Failed: ${failedCount}`);
    
    if (failedCount > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error("Fatal error in reminder checker:", error);
    process.exit(1);
  }
}

main();