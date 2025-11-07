// Netlify serverless function to check and send due reminders
// Triggered by external cron service (cron-job.org)

import TelegramBot from "node-telegram-bot-api";
import { getRemindersForToday, markReminderAsSent } from "../../utils/storage.js";

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