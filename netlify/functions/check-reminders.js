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
    
    // Find all reminder documents
    const allReminderDocs = await collection.find({}).toArray();
    
    console.log(`Found ${allReminderDocs.length} chat documents`);
    
    const todayReminders = [];
    
    for (const doc of allReminderDocs) {
      if (doc.reminders && Array.isArray(doc.reminders)) {
        console.log(`Chat ${doc.chatId} has ${doc.reminders.length} reminders`);
        
        for (const reminder of doc.reminders) {
          console.log(`Checking reminder: date=${reminder.date}, sent=${reminder.sent}, target=${dateString}`);
          
          // Check if reminder is for today and hasn't been sent
          // Note: Your current bot doesn't set 'sent' field, so we check if it's undefined or false
          if (reminder.date === dateString && (reminder.sent === false || reminder.sent === undefined)) {
            todayReminders.push({
              chatId: doc.chatId,
              message: reminder.text,
              date: reminder.date,
              reminderIndex: doc.reminders.indexOf(reminder)
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
    
    // Find the chat document
    const doc = await collection.findOne({ chatId: chatId });
    
    if (doc && doc.reminders) {
      // Find the specific reminder and mark it as sent
      const updatedReminders = doc.reminders.map(reminder => {
        if (reminder.date === reminderDate && reminder.text === reminderText) {
          return {
            ...reminder,
            sent: true,
            sentAt: new Date().toISOString()
          };
        }
        return reminder;
      });
      
      // Update the entire reminders array
      await collection.updateOne(
        { chatId: chatId },
        { $set: { reminders: updatedReminders, lastUpdated: new Date() } }
      );
      
      console.log(`Reminder marked as sent for chat ${chatId}`);
      return true;
    }
    
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
