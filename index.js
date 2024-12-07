import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const bot = new TelegramBot(process.env.TOKEN2, { polling: true });

const commands = [
  { command: "setreminder", description: "Set a reminder" },
  { command: "reminders", description: "View all reminders" },
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


bot.on("message", async (msg) => {
});
