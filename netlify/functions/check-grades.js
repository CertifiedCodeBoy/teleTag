// netlify/functions/check-grades.js
// Automatic grade checking - triggered by external cron service every 5 minutes

import TelegramBot from "node-telegram-bot-api";
import { MongoClient } from "mongodb";

// MongoDB helper
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

// Progres API functions
async function loginToProgres() {
  try {
    const response = await fetch(
      "https://progres.mesrs.dz/api/authentication/v1/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: process.env.PROGRES_USERNAME,
          password: process.env.PROGRES_PASSWORD,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Login failed: ${response.status}`);
    }

    const data = await response.json();
    const cardIds = data.dias.split(",").map((id) => id.trim());
    const cardId = cardIds[cardIds.length - 1];

    return {
      token: data.token,
      cardId: cardId,
      expirationDate: data.expirationDate,
    };
  } catch (error) {
    console.error("Progres login error:", error);
    throw error;
  }
}

async function fetchExamGrades(cardId, token) {
  try {
    const response = await fetch(
      `https://progres.mesrs.dz/api/infos/planningSession/dia/${cardId}/noteExamens`,
      {
        method: "GET",
        headers: {
          Authorization: token,
        },
      },
    );

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("AUTH_ERROR");
      }
      throw new Error(`Fetch exam grades failed: ${response.status}`);
    }

    const data = await response.json();
    return data.map((grade) => ({
      id: grade.id,
      moduleName: grade.mcLibelleFr,
      grade: grade.noteExamen,
    }));
  } catch (error) {
    console.error("Fetch exam grades error:", error);
    throw error;
  }
}

async function fetchCCGrades(cardId, token) {
  try {
    const response = await fetch(
      `https://progres.mesrs.dz/api/infos/controleContinue/dia/${cardId}/notesCC`,
      {
        method: "GET",
        headers: {
          Authorization: token,
        },
      },
    );

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("AUTH_ERROR");
      }
      throw new Error(`Fetch CC grades failed: ${response.status}`);
    }

    const data = await response.json();
    return data.map((grade) => ({
      id: grade.id,
      moduleName: grade.rattachementMcMcLibelleFr,
      grade: grade.note,
    }));
  } catch (error) {
    console.error("Fetch CC grades error:", error);
    throw error;
  }
}

async function getStoredGrades() {
  const db = await connectToDatabase();
  const collection = db.collection("grades");
  const gradesData = await collection.findOne({});
  return (
    gradesData || {
      cardId: null,
      token: null,
      tokenExpiry: null,
      examGrades: [],
      ccGrades: [],
      lastChecked: null,
    }
  );
}

async function updateStoredGrades(gradesData) {
  const db = await connectToDatabase();
  const collection = db.collection("grades");
  await collection.updateOne(
    {},
    {
      $set: {
        ...gradesData,
        lastUpdated: new Date(),
      },
    },
    { upsert: true },
  );
}

export async function handler(event, context) {
  console.log("Check-grades function triggered at:", new Date().toISOString());

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
    const bot = new TelegramBot(process.env.TOKEN);

    console.log("Starting automatic grade check...");

    // Get stored data
    let storedData = await getStoredGrades();
    let { token: authToken, cardId, tokenExpiry } = storedData;

    // Check if we need to login
    const needsLogin =
      !authToken || !cardId || new Date(tokenExpiry) <= new Date();

    if (needsLogin) {
      console.log("Logging in to Progres...");
      const loginData = await loginToProgres();
      authToken = loginData.token;
      cardId = loginData.cardId;
      tokenExpiry = loginData.expirationDate;

      storedData.token = authToken;
      storedData.cardId = cardId;
      storedData.tokenExpiry = tokenExpiry;
    }

    // Fetch current grades
    let examGrades, ccGrades;
    try {
      [examGrades, ccGrades] = await Promise.all([
        fetchExamGrades(cardId, authToken),
        fetchCCGrades(cardId, authToken),
      ]);
    } catch (error) {
      if (error.message === "AUTH_ERROR") {
        console.log("Token expired, re-logging in...");
        const loginData = await loginToProgres();
        authToken = loginData.token;
        cardId = loginData.cardId;
        tokenExpiry = loginData.expirationDate;

        [examGrades, ccGrades] = await Promise.all([
          fetchExamGrades(cardId, authToken),
          fetchCCGrades(cardId, authToken),
        ]);

        storedData.token = authToken;
        storedData.cardId = cardId;
        storedData.tokenExpiry = tokenExpiry;
      } else {
        throw error;
      }
    }

    // Compare and detect changes
    const changes = [];

    // Check exam grades
    for (const newGrade of examGrades) {
      const oldGrade = storedData.examGrades.find((g) => g.id === newGrade.id);

      if (oldGrade) {
        if (oldGrade.grade === null && newGrade.grade !== null) {
          changes.push({
            type: "exam",
            moduleName: newGrade.moduleName,
            oldGrade: oldGrade.grade,
            newGrade: newGrade.grade,
          });
        }
      } else if (newGrade.grade !== null) {
        changes.push({
          type: "exam",
          moduleName: newGrade.moduleName,
          oldGrade: null,
          newGrade: newGrade.grade,
        });
      }
    }

    // Check CC grades
    for (const newGrade of ccGrades) {
      const oldGrade = storedData.ccGrades.find((g) => g.id === newGrade.id);

      if (oldGrade) {
        if (oldGrade.grade === null && newGrade.grade !== null) {
          changes.push({
            type: "cc",
            moduleName: newGrade.moduleName,
            oldGrade: oldGrade.grade,
            newGrade: newGrade.grade,
          });
        }
      } else if (newGrade.grade !== null) {
        changes.push({
          type: "cc",
          moduleName: newGrade.moduleName,
          oldGrade: null,
          newGrade: newGrade.grade,
        });
      }
    }

    console.log(`Found ${changes.length} grade changes`);

    // Send notifications if changes found
    if (changes.length > 0) {
      const groupId = process.env.CLASS_GROUP_ID;
      const privateId = process.env.PRIVATE_CHAT_ID;

      // Send to class group (one message per module)
      for (const change of changes) {
        const groupMessage = `AFFICHAGE ${change.moduleName} PROGRES!`;
        try {
          await bot.sendMessage(groupId, groupMessage);
          console.log(`Sent group notification for: ${change.moduleName}`);
        } catch (error) {
          console.error(
            `Failed to send group notification for ${change.moduleName}:`,
            error.message,
          );
        }
      }

      // Send summary to private chat with your grades
      const privateSummary = changes
        .map(
          (change) =>
            `🎓 **${change.moduleName}**\n   Type: ${change.type === "exam" ? "Exam" : "CC"}\n   Grade: **${change.newGrade}**`,
        )
        .join("\n\n");

      const privateMessage = `🔔 **New Grades Posted!**\n\nFound ${changes.length} new grade(s):\n\n${privateSummary}\n\n_Checked at: ${new Date().toLocaleString("fr-FR", { timeZone: "Africa/Algiers" })}_`;

      try {
        await bot.sendMessage(privateId, privateMessage, {
          parse_mode: "Markdown",
        });
        console.log("Sent private summary to owner");
      } catch (error) {
        console.error("Failed to send private summary:", error.message);
      }
    }

    // Update stored grades
    storedData.examGrades = examGrades;
    storedData.ccGrades = ccGrades;
    storedData.lastChecked = new Date().toISOString();
    await updateStoredGrades(storedData);

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        checked: new Date().toISOString(),
        changesFound: changes.length,
        changes: changes.map((c) => ({
          module: c.moduleName,
          type: c.type,
          grade: c.newGrade,
        })),
      }),
    };
  } catch (error) {
    console.error("Error in check-grades function:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        message: error.message,
      }),
    };
  }
}
