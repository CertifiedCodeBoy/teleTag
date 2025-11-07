// Storage abstraction layer
// Currently uses JSON file, designed for easy migration to MongoDB

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REMINDERS_FILE = path.join(__dirname, "../data/reminders.json");

// Ensure data directory and file exist
async function ensureDataFile() {
  try {
    await fs.access(REMINDERS_FILE);
  } catch {
    // File doesn't exist, create it
    const dataDir = path.dirname(REMINDERS_FILE);
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(REMINDERS_FILE, "[@]");
  }
}

// Get all reminders for a specific date that haven't been sent
export async function getRemindersForToday(dateString) {
  await ensureDataFile();
  
  try {
    const data = await fs.readFile(REMINDERS_FILE, "utf-8");
    const allReminders = JSON.parse(data);
    
    // Filter for specific date and unsent status
    return allReminders.filter(
      (reminder) => reminder.date === dateString && reminder.sent === false
    );
  } catch (error) {
    console.error("Error reading reminders:", error);
    return [];
  }
}

// Mark a reminder as sent
export async function markReminderAsSent(reminderId) {
  await ensureDataFile();
  
  try {
    const data = await fs.readFile(REMINDERS_FILE, "utf-8");
    const allReminders = JSON.parse(data);
    
    // Find and update the reminder
    const reminder = allReminders.find((r) => r.id === reminderId);
    if (reminder) {
      reminder.sent = true;
      reminder.sentAt = new Date().toISOString();
      
      // Save back to file
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

// Add a new reminder
export async function addReminder(chatId, userId, username, message, date) {
  await ensureDataFile();
  
  try {
    const data = await fs.readFile(REMINDERS_FILE, "utf-8");
    const allReminders = JSON.parse(data);
    
    // Generate unique ID
    const id = `reminder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const newReminder = {
      id,
      chatId,
      userId,
      username,
      message,
      date, // Format: YYYY-MM-DD
      sent: false,
      createdAt: new Date().toISOString(),
    };
    
    allReminders.push(newReminder);
    
    await fs.writeFile(REMINDERS_FILE, JSON.stringify(allReminders, null, 2));
    console.log(`Reminder ${id} added for ${date}`);
    
    return newReminder;
  } catch (error) {
    console.error("Error adding reminder:", error);
    throw error;
  }
}

// Get all reminders for a specific user
export async function getUserReminders(userId) {
  await ensureDataFile();
  
  try {
    const data = await fs.readFile(REMINDERS_FILE, "utf-8");
    const allReminders = JSON.parse(data);
    
    return allReminders.filter((r) => r.userId === userId && !r.sent);
  } catch (error) {
    console.error("Error getting user reminders:", error);
    return [];
  }
}

// Delete a reminder
export async function deleteReminder(reminderId, userId) {
  await ensureDataFile();
  
  try {
    const data = await fs.readFile(REMINDERS_FILE, "utf-8");
    let allReminders = JSON.parse(data);
    
    const index = allReminders.findIndex((r) => r.id === reminderId && r.userId === userId);
    
    if (index !== -1) {
      allReminders.splice(index, 1);
      await fs.writeFile(REMINDERS_FILE, JSON.stringify(allReminders, null, 2));
      console.log(`Reminder ${reminderId} deleted`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error("Error deleting reminder:", error);
    return false;
  }
}

// ===== MONGODB MIGRATION PLACEHOLDER =====
// When switching to MongoDB, replace the functions above with:
//
// import { MongoClient } from "mongodb";
// const client = new MongoClient(process.env.MONGODB_URI);
// const db = client.db("teletag");
// const reminders = db.collection("reminders");
//
// export async function getRemindersForToday(dateString) {
//   return await reminders.find({ date: dateString, sent: false }).toArray();
// }
//
// export async function markReminderAsSent(reminderId) {
//   await reminders.updateOne(
//     { id: reminderId },
//     { $set: { sent: true, sentAt: new Date() } }
//   );
// }
//
// ... and so on for other functions
