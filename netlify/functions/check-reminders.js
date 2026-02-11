// check-reminders.js
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

async function getAllReminders() {
  try {
    const db = await connectToDatabase();
    const collection = db.collection("reminders");
    
    // Get ALL reminder documents to debug
    const allDocs = await collection.find({}).toArray();
    
    console.log("=== DEBUG: ALL REMINDER DOCUMENTS ===");
    console.log(JSON.stringify(allDocs, null, 2));
    
    return allDocs;
  } catch (error) {
    console.error("Error reading all reminders:", error);
    return [];
  }
}

async function getRemindersForToday(dateString) {
  try {
    const db = await connectToDatabase();
    const collection = db.collection("reminders");
    
    // Find all reminder documents
    const allReminderDocs = await collection.find({}).toArray();
    
    console.log(`=== Found ${allReminderDocs.length} chat documents in database ===`);
    
    const todayReminders = [];
    
    for (const doc of allReminderDocs) {
      console.log(`\n--- Processing chat ${doc.chatId} ---`);
      console.log(`Document structure:`, JSON.stringify(doc, null, 2));
      
      if (doc.reminders && Array.isArray(doc.reminders)) {
        console.log(`  ✓ Chat ${doc.chatId} has ${doc.reminders.length} reminders`);
        
        for (let i = 0; i < doc.reminders.length; i++) {
          const reminder = doc.reminders[i];
          console.log(`\n  Reminder #${i + 1}:`);
          console.log(`    - date: "${reminder.date}" (type: ${typeof reminder.date})`);
          console.log(`    - target date: "${dateString}" (type: ${typeof dateString})`);
          console.log(`    - dates match: ${reminder.date === dateString}`);
          console.log(`    - text: "${reminder.text}"`);
          console.log(`    - sent field: ${reminder.sent} (type: ${typeof reminder.sent})`);
          console.log(`    - sent is false or undefined: ${reminder.sent === false || reminder.sent === undefined}`);
          
          // Check if reminder is for today and hasn't been sent
          if (reminder.date === dateString && (reminder.sent === false || reminder.sent === undefined)) {
            console.log(`    ✓ MATCHED! Adding to send list`);
            todayReminders.push({
              chatId: doc.chatId,
              message: reminder.text,
              date: reminder.date,
              reminderIndex: i
            });
          } else {
            console.log(`    ✗ Not matched`);
          }
        }
      } else {
        console.log(`  ✗ Chat ${doc.chatId} has no reminders array`);
      }
    }
    
    console.log(`\n=== SUMMARY: Found ${todayReminders.length} reminders to send ===`);
    
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
    // Allow override with testDate parameter for testing
    const today = event.queryStringParameters?.testDate || new Date().toISOString().split("T")[0];
    console.log("=== Checking reminders for date:", today, "===");
    

    // DEBUG: Get all reminders first
    const allDocs = await getAllReminders();

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
        checkedDate: today,
        totalDocuments: allDocs.length,
        totalReminders: reminders.length,
        sent: sentCount,
        failed: failedCount,
        debug: {
          allDocuments: allDocs.map(d => ({
            chatId: d.chatId,
            reminderCount: d.reminders?.length || 0,
            reminders: d.reminders?.map(r => ({ date: r.date, text: r.text?.substring(0, 30) }))
          }))
        }
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
