import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';

// Persistent storage for group members

const groupMembers = new Map();
const mentionAllCooldowns = new Map();
const helpers = new Map();
const helpCooldown = new Map();

// Configure environment variables
dotenv.config();

// Create bot instance with polling
const bot = new TelegramBot(process.env.TOKEN, { polling: true });

const commands = [
    { command: 'join', description: 'Join the group' },
    { command: 'leave', description: 'Leave the group' },
    { command: 'showmembers', description: 'Show all members in the group' },
    { command: 'mentionall', description: 'Mention all members in the group' },
    { command: 'start', description: 'Start the bot' },
    { command: 'reset', description: 'Reset the bot and clear all queued requests' },
    { command: 'help', description: 'Seek help from one of the helpers' },
    { command : 'addtohelp', description: 'join helpers list'},
    { command: 'showhelpers', description: 'Show all helpers in the group' }

  ];
  
  bot.setMyCommands(commands).then(() => {
    console.log('Bot commands set successfully');
  }).catch((error) => {
    console.error('Error setting bot commands:', error);
  });

bot.on('message', async (msg) => {
  if (!msg || (msg.chat.type !== 'group' && msg.chat.type !== 'supergroup')) {
    return;
  }

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Ensure chat-specific members map exists
  if (!groupMembers.has(chatId)) {
    groupMembers.set(chatId, new Set());
  }
  if (!helpers.has(chatId)) {
    helpers.set(chatId, new Set());
  }
  const currentChatMembers = groupMembers.get(chatId);
  const currentHelpers = helpers.get(chatId);


  // Handle new chat members
  if (msg.new_chat_members) {
    msg.new_chat_members.forEach((member) => {
      bot.sendMessage(chatId, `${member.first_name} has joined the chat!`);
      currentChatMembers.add(member.id);
    });
  }

  // Handle members leaving
  if (msg.left_chat_member) {
    bot.sendMessage(chatId, `${msg.left_chat_member.first_name} has left the chat!`);
    currentChatMembers.delete(msg.left_chat_member.id);
  }

  // Command handlers
  if (msg.text) {
    const text = msg.text;

    if (text === '/join' || text === '/join@tagallesisbabot') {
      currentChatMembers.add(userId);
      await bot.sendMessage(chatId, 'You have joined the group!');
    }

    if (text === '/leave' || text === '/leave@tagallesisbabot') {
      currentChatMembers.delete(userId);
      await bot.sendMessage(chatId, 'You have left the group!');
    }

    if (text === '/showmembers' || text === '/showmembers@tagallesisbabot') {
      try {
        const membersList = [];
        for (const memberId of currentChatMembers) {
          try {
            const member = await bot.getChatMember(chatId, memberId);
            const user = member.user;
            membersList.push(user.username
              ? `${user.username}`
              : `${user.first_name} ${user.last_name || ''}`);
          } catch (error) {
            console.error(`Failed to get member info for user ID ${memberId}: ${error.message}`);
          }
        }

        const membersMessage = membersList.length > 0
          ? membersList.join('\n')
          : 'No members found.';

        await bot.sendMessage(chatId, membersMessage);
      } catch (error) {
        console.error(error.message);
      }
    }

    // Utility function to escape Markdown characters
function escapeMarkdown(text) {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); // Escapes special Markdown characters
  }
  
  // /mentionall Command
  if (text === '/mentionall' || text === '/mentionall@tagallesisbabot') {
    const now = Date.now();
    const userKey = `${chatId}:${msg.from.id}`; // Composite key for chat-user pair
  
    const userCooldown = mentionAllCooldowns.get(userKey);
  
    if (userCooldown && now < userCooldown) {
      const remainingTime = Math.ceil((userCooldown - now) / 1000);
      await bot.sendMessage(chatId, `Please wait ${remainingTime} seconds before using /mentionall again.`);
      return;
    }
  
    // Set new cooldown
    mentionAllCooldowns.set(userKey, now + 10000);
  
    try {
      const memberArray = Array.from(currentChatMembers);
  
      if (memberArray.length > 50) {
        await bot.sendMessage(chatId, 'Too many members to mention!');
        return;
      }
  
      const mentions = [];
      for (const memberId of memberArray) {
        try {
          const member = await bot.getChatMember(chatId, memberId).catch(() => null);
  
          if (!member || !member.user) continue;
  
          const user = member.user;
          mentions.push(user.username
            ? `@${escapeMarkdown(user.username)}`
            : `[${escapeMarkdown(user.first_name)}](tg://user?id=${user.id})`);
        } catch (error) {
          console.error(`[DEBUG] Mention error for user ${memberId}:`, error);
        }
      }
  
      if (mentions.length === 0) {
        await bot.sendMessage(chatId, 'No members could be mentioned.');
        return;
      }
  
      if (mentions.join(' ').length > 4096) {
        const chunks = [];
        let currentChunk = [];
        let currentLength = 0;
  
        for (const mention of mentions) {
          if (currentLength + mention.length > 4096) {
            chunks.push(currentChunk.join(' '));
            currentChunk = [];
            currentLength = 0;
          }
          currentChunk.push(mention);
          currentLength += mention.length;
        }
  
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.join(' '));
        }
  
        for (const chunk of chunks) {
          await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
        }
      } else {
        await bot.sendMessage(chatId, mentions.join(' '), { parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error('[DEBUG] Mentioning all error:', error);
      await bot.sendMessage(chatId, 'Failed to mention all members.');
    }
  }
  
  // /help Command
  if (text === '/help' || text === '/help@tagallesisbabot') {
    const now = Date.now();
    const userKey = `${chatId}:${msg.from.id}`;
  
    const userCooldown = helpCooldown.get(userKey);
  
    if (userCooldown && now < userCooldown) {
      const remainingTime = Math.ceil((userCooldown - now) / 1000);
      await bot.sendMessage(chatId, `Please wait ${remainingTime} seconds before using /help again.`);
      return;
    }
  
    helpCooldown.set(userKey, now + 10000);
  
    try {
      const helpersArray = Array.from(currentHelpers);
  
      if (helpersArray.length === 0) {
        await bot.sendMessage(chatId, 'No helpers are currently available.');
        return;
      }
  
      const mentions = helpersArray.map(async (helperId) => {
        try {
          const helper = await bot.getChatMember(chatId, helperId).catch(() => null);
          if (!helper || !helper.user) return null;
  
          const user = helper.user;
          return user.username
            ? `@${escapeMarkdown(user.username)}`
            : `[${escapeMarkdown(user.first_name)}](tg://user?id=${user.id})`;
        } catch (error) {
          console.error(`[DEBUG] Mention error for helper ${helperId}:`, error);
          return null;
        }
      });
  
      const resolvedMentions = (await Promise.all(mentions)).filter(Boolean);
  
      if (resolvedMentions.length === 0) {
        await bot.sendMessage(chatId, 'No helpers could be mentioned.');
        return;
      }
  
      await bot.sendMessage(chatId, resolvedMentions.join(' '), { parse_mode: 'Markdown' });
    } catch (error) {
      console.error('[DEBUG] Help command error:', error);
      await bot.sendMessage(chatId, 'Failed to mention helpers.');
    }
  }
  
    

    if (text === '/start' || text === '/start@tagallesisbabot') {
      await bot.sendMessage(chatId, "Hello! Use /join to join a group.");
    }

      if (text === '/showhelpers' || text === '/showhelpers@tagallesisbabot') {
        try {
          const membersList = [];
          for (const memberId of currentHelpers) {
            try {
              const member = await bot.getChatMember(chatId, memberId);
              const user = member.user;
              membersList.push(user.username
                ? `${user.username}`
                : `${user.first_name} ${user.last_name || ''}`);
            } catch (error) {
              console.error(`Failed to get member info for user ID ${memberId}: ${error.message}`);
            }
          }
  
          const membersMessage = membersList.length > 0
            ? membersList.join('\n')
            : 'No members found.';
  
          await bot.sendMessage(chatId, membersMessage);
        } catch (error) {
          console.error(error.message);
        }
      }
    
      // Handle /addtohelp command
      if (text === '/addtohelp' || text === '/addtohelp@tagallesisbabot') {
        if (!currentHelpers.has(userId)) {
          currentHelpers.add(userId);
          await bot.sendMessage(chatId, 'You have joined the helpers!');
        } else {
          await bot.sendMessage(chatId, 'You are already a helper!');
        }
      }

      if (text === '/reset' || text === '/reset@tagallesisbabot') {
        groupMembers.set(chatId, new Set());
        helpers.set(chatId, new Set());
        await bot.sendMessage(chatId, 'Bot has been reset and all queued requests have been cleared.');
      }
  }
});