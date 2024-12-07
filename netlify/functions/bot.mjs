import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const bot = new TelegramBot(process.env.TOKEN);

// MongoDB Setup
const mongoClient = new MongoClient(process.env.MONGO_URI); // Replace with your MongoDB URI
let db;

async function connectToDatabase() {
  if (!db) {
    try{ mongoClient.connect();
    db = mongoClient.db('teleTag'); // Database name
    console.log('Connected to MongoDB');
  } catch(err) {
    console.error('Error connecting to MongoDB', err);
  } }
}

async function exampleFunction() {
  await connectToDatabase();
}

exampleFunction();

const membersCollection = () => {
  if (!db) throw new Error('Database not initialized');
  return db.collection('groupMembers');
};
const helpersCollection = () => {
  if (!db) throw new Error('Database not initialized');
  return db.collection('helpers');
};

const commands = [
  { command: 'start', description: 'Start the bot' },
  { command: 'join', description: 'Join the group' },
  { command: 'leave', description: 'Leave the group' },
  { command: 'showmembers', description: 'Show all members in the group' },
  { command: 'mentionall', description: 'Mention all members in the group' },
  { command: 'help', description: 'Seek help from one of the helpers' },
  { command: 'addtohelp', description: 'Join helpers list' },
  { command: 'showhelpers', description: 'Show all helpers in the group' },
  { command: 'leavehelpers', description: 'Leave the helpers' },
  { command: 'reset', description: 'Reset the bot and clear all queued requests' },
];

bot.setMyCommands(commands).then(() => {
  console.log('Bot commands set successfully');
}).catch((error) => {
  console.error('Error setting bot commands:', error);
});

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

// Utility function to escape Markdown characters
// function escapeMarkdown(text) {
//   return text.replace(/[_*\[\]()~`>#+\-=|{}.!]/g, '\\$&'); // Escapes special Markdown characters
// }
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
// Handle Updates
export default async function handler(event,res) {
  try {
    let bodyString;
    if (event.body instanceof ReadableStream) {
      bodyString = await readStream(event.body);
    } else {
      bodyString = event.body;
    }

    const body = JSON.parse(bodyString);
    // const body = bodyString;
    const msg = body.message;
    if (!msg || !msg.text) {
      return new Response(
        JSON.stringify({ message: 'No message or text to process' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Handle Commands
    const text = msg.text;

    if (text === '/join' || text === '/join@tagallesisbabot') {
      const groupData = await getGroupMembers(chatId);
      const user = { id: userId, first_name: msg.from.first_name };
    
      if (!groupData.members.some(member => member.id === userId)) {
        groupData.members.push(user);
        await updateGroupMembers(chatId, groupData.members);
        await bot.sendMessage(chatId, 'You have joined the group!');
      } else {
        await bot.sendMessage(chatId, 'You are already a member!');
      }
    }

 if (text === '/leave' || text === '/leave@tagallesisbabot') {
  const groupData = await getGroupMembers(chatId);
  const userIndex = groupData.members.findIndex(member => member.id === userId);

  if (userIndex !== -1) {
    groupData.members.splice(userIndex, 1);
    await updateGroupMembers(chatId, groupData.members);
    await bot.sendMessage(chatId, 'You have left the group!');
  } else {
    await bot.sendMessage(chatId, 'You are not a member!');
  }
}

    if (text === '/showmembers' || text === '/showmembers@tagallesisbabot') {
      const groupData = await getGroupMembers(chatId);
      const membersMessage = groupData.members.length
        ? groupData.members.map(member => member.first_name).join(', ')
        : 'No members found.';
      await bot.sendMessage(chatId, membersMessage);
    }

    if (text === '/mentionall' || text === '/mentionall@tagallesisbabot') {
      const groupData = await getGroupMembers(chatId);
      const mentions = groupData.members.map(id => `[${
        msg.from.first_name
      }](tg://user?id=${id})`);
      // mention by first name because it's required and always available:
    
      const message = mentions.length
        ? mentions.join(' ')
        : 'No members to mention.';
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    if (text === '/addtohelp' || text === '/addtohelp@tagallesisbabot') {
      const helpersData = await getHelpers(chatId);
      const helper = { id: userId, first_name: msg.from.first_name };
    
      if (!helpersData.helpers.some(h => h.id === userId)) {
        helpersData.helpers.push(helper);
        await updateHelpers(chatId, helpersData.helpers);
        await bot.sendMessage(chatId, 'You have joined the helpers!');
      } else {
        await bot.sendMessage(chatId, 'You are already a helper!');
      }
    }

    if (text === '/showhelpers' || text === '/showhelpers@tagallesisbabot') {
      const helpersData = await getHelpers(chatId);
      const helpersMessage = helpersData.helpers.length
        ? helpersData.helpers.map(helper => helper.first_name).join(', ')
        : 'No helpers found.';
      await bot.sendMessage(chatId, helpersMessage);
    }

    if (text === '/leavehelpers' || text === '/leavehelpers@tagallesisbabot') {
      const helpersData = await getHelpers(chatId);
      const userIndex = helpersData.helpers.findIndex(helper => helper.id === userId);
    
      if (userIndex !== -1) {
        helpersData.helpers.splice(userIndex, 1);
        await updateHelpers(chatId, helpersData.helpers);
        await bot.sendMessage(chatId, 'You have left the helpers!');
      } else {
        await bot.sendMessage(chatId, 'You are not a helper!');
      }
    }

    if (text === '/reset' || text === '/reset@tagallesisbabot') {
      await updateGroupMembers(chatId, []);
      await updateHelpers(chatId, []);
      await bot.sendMessage(chatId, 'Bot has been reset.');
    }

   if (text === '/help' || text === '/help@tagallesisbabot') {
  const helpersData = await getHelpers(chatId);
  const mentions = helpersData.helpers.map(helper => `[${helper.first_name}](tg://user?id=${helper.id})`);
  const message = mentions.length
    ? mentions.join(' ')
    : 'No helpers available right now.';
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

    if (text === '/start' || text === '/start@tagallesisbabot') {
      await bot.sendMessage(chatId, 'Hello! Use /join to join the group.');
    }
    
    // res.status(200).send('OK');
    return new Response(
      JSON.stringify({ message: 'Message processed successfully' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Error:', error);

    return new Response(
      JSON.stringify({
        message: 'Internal Server Error',
        error: error.message,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}