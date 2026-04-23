import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";
import {
  MEAL_OPTIONS,
  executeReservationForAccounts,
  getAlgeriaDateKey,
  maskIdentifier,
} from "./reserve-utils.mjs";

let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) {
    return cachedDb;
  }

  const client = await MongoClient.connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  });

  cachedDb = client.db("teleTag");
  return cachedDb;
}

function getAlgeriaHour(date = new Date()) {
  const local = new Date(
    date.toLocaleString("en-US", { timeZone: "Africa/Algiers" }),
  );
  return local.getHours();
}

function mealTypesToText(mealTypes = []) {
  return mealTypes
    .map((meal) => MEAL_OPTIONS[meal])
    .filter(Boolean)
    .join(", ");
}

function formatDailyMessage(profile, runResult, attempt, willRetry) {
  const lines = [];
  lines.push("Meal reservation update");
  lines.push(`Status: ${runResult.overallStatus}`);
  lines.push(`Attempt: ${attempt}/2`);
  lines.push(`Dates: ${runResult.dateStrings.join(", ")}`);
  lines.push(`Meals: ${mealTypesToText(profile.mealTypes || [1, 2, 3])}`);
  lines.push(
    `Accounts success: ${runResult.successCount}/${runResult.results.length}`,
  );

  const failed = runResult.results.filter((item) => !item.success);
  if (failed.length > 0) {
    lines.push("");
    lines.push("Failed accounts:");
    for (const item of failed) {
      lines.push(`- ${maskIdentifier(item.username)}: ${item.error}`);
    }
  }

  if (willRetry) {
    lines.push("");
    lines.push("Retry will run once more before midnight.");
  }

  return lines.join("\n");
}

export async function handler(event) {
  // Security: Validate token
  const token = event.queryStringParameters?.token;
  if (!token || token !== process.env.CRON_SECRET) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: "Unauthorized" }),
    };
  }

  const forceRun = event.queryStringParameters?.force === "1";
  const algeriaHour = getAlgeriaHour();
  if (!forceRun && algeriaHour !== 23) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        skipped: true,
        reason: "Outside 23:00 Algeria hour",
        algeriaHour,
      }),
    };
  }

  const todayKey = getAlgeriaDateKey();

  try {
    const db = await connectToDatabase();
    const collection = db.collection("mealReservations");
    const profiles = await collection.find({ autoEnabled: true }).toArray();

    const bot = new TelegramBot(process.env.TOKEN);

    let attemptedProfiles = 0;
    let succeededProfiles = 0;
    let failedProfiles = 0;
    let skippedProfiles = 0;

    for (const profile of profiles) {
      const lastRun = profile.lastRun || {};
      const sameDay = lastRun.dayKey === todayKey;
      const previousAttempt = sameDay ? Number(lastRun.attempt || 0) : 0;

      if (sameDay && lastRun.status === "success") {
        skippedProfiles++;
        continue;
      }

      if (sameDay && previousAttempt >= 2) {
        skippedProfiles++;
        continue;
      }

      const attempt = previousAttempt + 1;
      attemptedProfiles++;

      const runResult = await executeReservationForAccounts(profile, {
        daysAhead: 3,
      });

      if (runResult.overallStatus === "success") {
        succeededProfiles++;
      } else {
        failedProfiles++;
      }

      await collection.updateOne(
        { ownerUserId: profile.ownerUserId },
        {
          $set: {
            lastRun: {
              dayKey: todayKey,
              attempt,
              status: runResult.overallStatus,
              attemptedAt: new Date().toISOString(),
              successCount: runResult.successCount,
              failedCount: runResult.failedCount,
              dateStrings: runResult.dateStrings,
              results: runResult.results,
            },
            updatedAt: new Date(),
          },
        },
      );

      const shouldRetry =
        runResult.overallStatus !== "success" &&
        attempt < 2 &&
        algeriaHour === 23;

      if (profile.ownerChatId) {
        try {
          await bot.sendMessage(
            profile.ownerChatId,
            formatDailyMessage(profile, runResult, attempt, shouldRetry),
          );
        } catch (error) {
          console.error(
            `Failed to send reservation update to ${profile.ownerChatId}:`,
            error.message,
          );
        }
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        dayKey: todayKey,
        totalProfiles: profiles.length,
        attemptedProfiles,
        succeededProfiles,
        failedProfiles,
        skippedProfiles,
      }),
    };
  } catch (error) {
    console.error("check-reservations error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        message: error.message,
      }),
    };
  }
}
