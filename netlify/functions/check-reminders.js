// Netlify serverless function to check and send due reminders
// Triggered by external cron service (cron-job.org)

import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";

// MongoDB helper functions
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }

  const client = await MongoClient.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  const db = client.db("teleTag");
  cachedDb = db;
  return db;
}

async function getRemindersForToday(dateString) {
  try {
    const db = await connectToDatabase();
    const collection = db.collection("reminders");
    
    // Find all reminders for today that haven't been sent
    const allReminders = await collection.find({}).toArray();
    
    const todayReminders = [];
    for (const doc of allReminders) {
      if (doc.reminders && Array.isArray(doc.reminders)) {
        for (const reminder of doc.reminders) {
          if (reminder.date === dateString && !reminder.sent) {
            todayReminders.push({
              id: reminder._id || reminder.date + reminder.text,
              chatId: doc.chatId,
              message: reminder.text,
              date: reminder.date,
              sent: reminder.sent || false,
            });
          }
        }
      }
    }
    
    return todayReminders;
  } catch (error) {
    console.error("Error reading reminders:", error);
    return [];
  }
}

async function markReminderAsSent(chatId, reminderDate, reminderText) {
  try {
    const db = await connectToDatabase();
    const collection = db.collection("reminders");
    
    // Update the specific reminder in the array
    await collection.updateOne(
      { 
        chatId: chatId,
        "reminders.date": reminderDate,
        "reminders.text": reminderText
      },
      {
        $set: {
          "reminders.$.sent": true,
          "reminders.$.sentAt": new Date().toISOString()
        }
      }
    );
    
    console.log(`Reminder marked as sent for chat ${chatId}`);
    return true;
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
    const bot = new TelegramBot(process.env.TOKEN);

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
        await markReminderAsSent(reminder.chatId, reminder.date, reminder.message);
        sentCount++;
        console.log(`Sent reminder to chat ${reminder.chatId}`);
      } catch (error) {
        failedCount++;
        console.error(`Failed to send reminder to chat ${reminder.chatId}:`, error.message);
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
