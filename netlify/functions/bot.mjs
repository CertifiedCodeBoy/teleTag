import TelegramBot from "node-telegram-bot-api";

import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const bot = new TelegramBot(process.env.TOKEN);

const mongoClient = new MongoClient(process.env.MONGO_URI);
let db;

async function connectToDatabase() {
  if (!db) {
    try {
      mongoClient.connect();
      db = mongoClient.db("teleTag"); // Database name
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

// Helper Functions
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
  if (text === "/start" || text === "/start@tagallesisbabot") {
    await bot.sendMessage(chatId, "Hello! Use /join to join the group.");
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
            // show the date in a more readable format
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

  if (text === "/reset" || text === "/reset@tagallesisbabot") {
    await updateGroupMembers(chatId, []);
    await updateHelpers(chatId, []);
    await updateReminders(chatId, []);
    await bot.sendMessage(chatId, "Bot has been reset.");
  }
}

export default async function handler(event, res) {
  try {
    const bodyString = await readStream(event.body);
    // const bodyString = event.body;

    const body = JSON.parse(bodyString);
    // const body = bodyString;

    const msg = body.message;
    if (!msg || !msg.text) {
      return new Response(
        JSON.stringify({ message: "No message or text to process" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Handle Commands
    const text = msg.text;

    await staticCommands(text, chatId, userId, msg);

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

    // clear a specific reminder by index
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

    if (
      text.startsWith("/setreminder") ||
      text.startsWith("/setreminder@tagallesisbabot")
    ) {
      // try catch block to handle errors
      try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const remindersData = await getReminders(chatId);
        const date = text.split(" ")[1];
        const messageText = msg.reply_to_message?.text;

        // if reminder is already set for the message at the same date
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

    // res.status(200).send("OK");
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
