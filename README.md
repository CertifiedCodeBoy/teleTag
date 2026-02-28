# teleTag 🤖

A feature-rich Telegram bot built for Algerian university group chats. It handles group coordination, AI-powered academic assistance, automated grade notifications, reminders, and group games — all running serverlessly on Netlify.

---

## Features

### 👥 Group Management

Maintain a persistent member list stored in MongoDB. Mention everyone with a single command.

| Command        | Description                           |
| -------------- | ------------------------------------- |
| `/join`        | Add yourself to the group member list |
| `/leave`       | Remove yourself from the member list  |
| `/showmembers` | List all registered members           |
| `/mentionall`  | Ping every member in the group        |

---

### 🆘 Helpers System

A dedicated pool of volunteers who can be summoned when someone needs help.

| Command         | Description                               |
| --------------- | ----------------------------------------- |
| `/addtohelp`    | Join the helpers team                     |
| `/leavehelpers` | Leave the helpers team                    |
| `/showhelpers`  | View all current helpers                  |
| `/help`         | Mention all helpers to request assistance |

---

### ⏰ Reminders

Set date-based reminders for the group. An automated function fires the message on the due date.

| Command                             | Description                        |
| ----------------------------------- | ---------------------------------- |
| `/setreminder YYYY-MM-DD <message>` | Set a reminder for a future date   |
| `/reminders`                        | View all active reminders          |
| `/clearreminder <index,...>`        | Remove specific reminders by index |
| `/clearreminders`                   | Clear all reminders for the group  |

---

### 🤖 AI Assistant (Gemini 2.5 Flash)

Powered by Google Gemini 2.5 Flash with per-user conversation history, rate limiting, and multimodal support (images & PDFs).

| Command                | Description                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/ask <question>`      | Chat with the AI (maintains conversation context)                                                                                       |
| `/translate`           | Translate a replied message — auto-detects language and translates EN↔AR, or specify a target: `/translate to French`                   |
| `/summarize`           | Summarize a replied message                                                                                                             |
| `/solve`               | Solve an exercise — reply to an image/PDF or type the problem directly. Outputs LaTeX for math, commented code for programming problems |
| `/qcm <topic>`         | Generate a 5-question multiple-choice quiz with spoiler-tagged answers                                                                  |
| `/email <description>` | Generate a formal French academic email from a plain-language description                                                               |
| `/clearai`             | Clear your personal AI conversation history                                                                                             |
| `/credits`             | Check today's Gemini API usage count                                                                                                    |

---

### 📊 Grade Notifications (Progres)

Monitors the Algerian university portal ([progres.mesrs.dz](https://progres.mesrs.dz)) for new exam and TD/TP grades. When a grade is published, the bot sends an automatic notification to the group.

| Command  | Description                    |
| -------- | ------------------------------ |
| `/check` | Manually trigger a grade check |

Automated checking runs every few minutes via an external cron service hitting the `/api/check-grades` endpoint.

---

### 🎮 Games & Fun

| Command                   | Description                                    |
| ------------------------- | ---------------------------------------------- |
| `/games`                  | Browse available group games                   |
| `/wheel opt1, opt2, opt3` | Spin an animated wheel (options passed inline) |
| `/wheeladd <option>`      | Save a persistent option to the group's wheel  |
| `/wheelremove <index>`    | Remove a saved wheel option by index           |
| `/wheelshow`              | View the group's saved wheel options           |

---

## Tech Stack

| Layer         | Technology                                      |
| ------------- | ----------------------------------------------- |
| Runtime       | Node.js (ESM)                                   |
| Bot Framework | `node-telegram-bot-api`                         |
| Hosting       | Netlify Functions (serverless, webhook mode)    |
| Database      | MongoDB Atlas                                   |
| AI            | Google Gemini 2.5 Flash                         |
| Cron Triggers | [cron-job.org](https://cron-job.org) (external) |

---

## Project Structure

```
teleTag/
├── netlify/
│   └── functions/
│       ├── bot.mjs              # Main webhook handler — all bot logic
│       ├── check-grades.js      # Cron function: poll Progres for new grades
│       └── check-reminders.js   # Cron function: fire due reminders
├── features/
│   └── notes/
│       └── scaling-ideas.md     # Architecture & future ideas
├── index.js                     # Local polling entry point (dev only)
├── server.mjs                   # Express server wrapper (dev only)
├── netlify.toml                 # Netlify build & redirect config
└── package.json
```

---

## Environment Variables

Create a `.env` file at the project root (or set these in your Netlify dashboard):

```env
# Telegram
TOKEN=your_telegram_bot_token

# MongoDB
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/

# Google Gemini
GEMINI_API_KEY=your_gemini_api_key

# Progres (Algerian university portal credentials)
PROGRES_USERNAME=your_progres_username
PROGRES_PASSWORD=your_progres_password

# The Telegram group ID to send grade notifications to
CLASS_GROUP_ID=your_telegram_group_chat_id
```

---

## Deployment

### Netlify (Production)

1. Push the repo to GitHub and link it to a Netlify site.
2. Set all environment variables in **Netlify → Site settings → Environment variables**.
3. Deploy — Netlify will automatically serve the functions under `/.netlify/functions/`.

The `netlify.toml` redirects `/api/*` to `/.netlify/functions/:splat`, so the webhook URL is:

```
https://<your-site>.netlify.app/api/bot
```

4. Register the webhook with Telegram:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-site>.netlify.app/api/bot
```

### Cron Jobs

Set up two cron jobs on [cron-job.org](https://cron-job.org) (or any HTTP cron service):

| Endpoint                   | Frequency       | Purpose                      |
| -------------------------- | --------------- | ---------------------------- |
| `GET /api/check-grades`    | Every 5 minutes | Poll Progres for new grades  |
| `GET /api/check-reminders` | Once daily      | Send due reminders to groups |

### Local Development

```bash
npm install
netlify dev
```

This starts the Netlify dev server with function emulation. Use a tunneling tool (e.g. `ngrok`) to expose the local server for Telegram webhook testing.

---

## MongoDB Collections

| Collection        | Purpose                            |
| ----------------- | ---------------------------------- |
| `groupMembers`    | Registered members per chat        |
| `helpers`         | Helper volunteers per chat         |
| `reminders`       | Active reminders per chat          |
| `grades`          | Stored Progres grades + auth token |
| `aiConversations` | Per-user AI conversation history   |
| `apiUsage`        | Daily Gemini API call counter      |
| `wheelOptions`    | Saved wheel options per chat       |

---

## License

ISC
