# TeleTag Bot - Comprehensive Deployment Documentation

**Last Updated:** April 27, 2026  
**Current Version:** 1.0.0  
**Primary Language:** Node.js (ES Modules) with supporting Python utilities

---

## TABLE OF CONTENTS

1. [System Architecture](#system-architecture)
2. [Bot Features](#bot-features)
3. [Auto Meal Reservation System](#auto-meal-reservation-system)
4. [Database Schema](#database-schema)
5. [Deployment & Infrastructure](#deployment--infrastructure)
6. [Environment Variables](#environment-variables)
7. [API Integration Details](#api-integration-details)
8. [Known Issues & Bugfixes](#known-issues--bugfixes)
9. [Command Reference](#command-reference)
10. [Future Roadmap](#future-roadmap)

---

## SYSTEM ARCHITECTURE

### Overview

TeleTag is a comprehensive Telegram bot for Algerian university students, deployed on Netlify Functions with MongoDB for persistence. The bot operates as a Telegram webhook receiver and performs complex operations including:

- Group member and helper management
- Telegram reminders system
- AI-powered conversation & utilities
- Grade monitoring from Progres API
- Interactive games
- Meal reservation automation with WebEtu/ONOU integration

### Technology Stack

- **Bot Framework:** `node-telegram-bot-api` (v0.61.0)
- **Runtime:** Node.js 18+ (ES Modules)
- **Deployment:** Netlify Functions + Express.js (local development)
- **Database:** MongoDB (Atlas or self-hosted)
- **External APIs:**
  - Telegram Bot API
  - Google Gemini 2.5 Flash (AI)
  - WebEtu API (authentication, student data)
  - ONOU API (meal reservations)
  - Progres API (grade checking)
- **Cryptography:** Node.js `crypto` module (AES-256-GCM)

### Core Components

#### 1. **bot.mjs** (Primary Webhook Handler)

- Netlify Function entry point
- Handles all Telegram updates (messages, callbacks, new members)
- Implements rate limiting, caching, and error recovery
- Manages state machines for multi-step flows (e.g., `/reserve` setup)

#### 2. **reserve-utils.mjs** (Meal Reservation Engine)

- Credential encryption/decryption (AES-256-GCM)
- WebEtu authentication & ONOU token exchange
- Restaurant/depot fetching and meal reservation logic
- Chunk account processing and failure handling

#### 3. **check-reservations.js** (Daily Cron Function)

- Triggered externally at 23:00 Algeria time
- Processes auto-enabled reservation profiles
- Implements retry logic (up to 2 attempts per day)
- Sends daily status updates to users

#### 4. **server.mjs** (Local Development Server)

- Express.js wrapper for local testing
- Mirrors Netlify webhook endpoint at `POST /webhook`

### Data Flow

```
Telegram User Message
        ↓
Telegram Bot API
        ↓
Netlify Function (bot.mjs handler)
        ↓
MongoDB (read/write state, profiles, conversations)
        ↓
External APIs (WebEtu, ONOU, Gemini, Progres)
        ↓
Response back to Telegram
        ↓
User receives message/callback response
```

---

## BOT FEATURES

### 1. GROUP MANAGEMENT

#### Commands

- `/join` – Register in group members database
- `/leave` – Remove from group members
- `/showmembers` – List all registered members
- `/mentionall` (aliases: `/everyone`) – Tag all members

**Storage:** MongoDB collection `groupMembers` (one doc per group with `chatId`)

---

### 2. HELPER SYSTEM

#### Commands

- `/addtohelp` – Join helper team
- `/leavehelpers` – Leave helper team
- `/showhelpers` – View all helpers in group
- `/help` – Request help (mentions all helpers)

**Storage:** MongoDB collection `helpers`

---

### 3. TELEGRAM REMINDERS

#### Commands

- `/setreminder YYYY-MM-DD "message"` – Set date-based reminder (reply to a message)
- `/reminders` – View active reminders
- `/clearreminders` – Delete all reminders
- `/clearreminder 1,2,5` – Delete specific reminders by index (comma-separated)

**Logic:**

- Reminders are checked daily at 15:33 (hardcoded trigger in bot.mjs)
- Past reminders are auto-removed
- Validation ensures dates are 1-31 days in future, no weekday validation

**Storage:** MongoDB collection `reminders` (one doc per group)

---

### 4. AI-POWERED FEATURES

#### 4.1 Conversation Engine

**Command:** `/ask <question>` (with optional reply context)

**Features:**

- Maintains conversation history per user+group (last 20 messages)
- Auto-detects reply context and includes in prompt
- Rate limiting: 10 requests/minute per user
- Multimodal support: if replying to file, downloads and sends to Gemini
- Smart context truncation (max 25,000 tokens)

**Model:** Gemini 2.5 Flash (via Google Generative AI API)

**Caching:** 5-minute TTL on conversation history

**Storage:** MongoDB collection `aiConversations`

#### 4.2 Translation

**Command:** `/translate` (reply to message) or `/translate to {language}`

**Features:**

- Auto-detects language and translates to English/Arabic by default
- Supports custom target language: `/translate to spanish`
- Preserves Telegram formatting (bold, italic, code blocks)
- Chunks text >20KB into 20KB segments

#### 4.3 Summarization

**Command:** `/summarize` (reply to message)

**Features:**

- Condenses text into bullet-point summaries
- Uses markdown formatting with emojis
- Supports texts up to 20KB (chunked if needed)

#### 4.4 QCM (Multiple Choice Quiz) Generator

**Command:** `/qcm <topic>`

**Output:**

- Exactly 5 multiple-choice questions (A/B/C/D)
- Hidden answers using Telegram spoiler tags (`<tg-spoiler>`)
- Format: `||Answer: X||` converted to HTML spoiler

**Example:** `/qcm algorithmique`

#### 4.5 Exercise Solver with Multimodal Support

**Command:** `/solve` or `/solve <hint>` (reply to file/PDF/image)

**Features:**

- Analyzes files (images, PDFs, text documents)
- Auto-detects programming language from context hints
- Returns LaTeX for math, clean code for programming
- Chunks response if >4000 chars (sends multiple messages)
- Supports: Java, JavaScript, Python, Arduino, C++, C, SQL, HTML/CSS

#### 4.6 Email Generator

**Command:** `/email <description>`

**Features:**

- Generates formal French academic emails
- Auto-detects civility (Monsieur/Madame) from description
- Adjusts greeting based on Algeria local time (Bonjour/Bonsoir)
- Template: Subject + greeting + body + signature

**Example:** `/email ask professor to postpone exam`

#### 4.7 API Usage Tracking

**Command:** `/credits`

**Display:**

- Today's API request count
- Gemini 2.5 Flash model info
- Free tier limits (15 req/min, 1,500 req/day, 1M tokens/day)
- Current API status

**Storage:** MongoDB collection `apiUsage` (auto-expires after 24h with TTL index)

---

### 5. GRADE CHECKING (PROGRES API)

#### Command

`/check` – Manually trigger grade check

#### Automated Execution

- Called by cron job (external trigger)
- Detects new grade posts (null → score transition)
- Sends notifications to `CLASS_GROUP_ID`

#### Process Flow

1. Login to Progres API with `PROGRES_USERNAME` / `PROGRES_PASSWORD`
2. Extract most recent card ID from `dias` array
3. Fetch exam grades: `/api/infos/planningSession/dia/{cardId}/noteExamens`
4. Fetch CC (continuous assessment) grades: `/api/infos/controleContinue/dia/{cardId}/notesCC`
5. Compare with stored grades (in MongoDB `grades` collection)
6. Detect changes: `null → score`
7. Send formatted message: `AFFICHAGE {TYPE} {MODULE_NAME} PROGRES!`

**Storage:** MongoDB collection `grades`

- Fields: `cardId`, `token`, `tokenExpiry`, `examGrades[]`, `ccGrades[]`, `lastChecked`

**Token Refresh:** Automatic on expiration or 401 response

---

### 6. INTERACTIVE GAMES

#### Command

`/games` – Display game selection buttons

#### Available Games

- **🎭 Truth** – Personal question generator
- **😈 Dare** – Challenge generator
- **🤔 Would You Rather** – Dilemma generator (hard-choice format)
- **🧠 Trivia** – 4-option quiz with hidden answer
- **🔥 Hot Take** – Controversial opinion for debate
- **🧩 Riddle** – Brain teaser with hidden answer
- **📖 Story Builder** – First sentence of collaborative story
- **✏️ Finish the Sentence** – Incomplete sentence to complete
- **🔡 Acronym** – Random acronym with creative sentence challenge
- **😤 Unpopular Opinion** – Divisive statement generator

**Implementation:**

- Callback buttons trigger `game_*` handlers
- Each game calls Gemini API with specific prompt
- Answers wrapped in `||spoiler||` converted to `<tg-spoiler>` HTML tags

---

### 7. INTERACTIVE WHEEL / SPINNER

#### Commands

- `/wheel pizza, sushi, burgers` – Spin inline options
- `/wheel` – Spin saved group wheel
- `/wheeladd <option>` – Add to saved wheel
- `/wheelremove <index>` – Remove by position
- `/wheelshow` – List saved options

**Animation:**

- Cycles through options 2 times at 150ms start → 500ms end (easing)
- Final frame holds winner for 600ms
- Updates message in-place via `editMessageText`

**Storage:** MongoDB collection `wheelOptions`

---

## AUTO MEAL RESERVATION SYSTEM

### Overview

End-to-end automated meal reservation for Algerian university students via ONOU/WebEtu APIs with encrypted credential storage and daily cron-based execution.

### Key Features

#### ✅ Complete Implementation

1. **Single-account mode** – One primary account with one residence/restaurant
2. **Chunk bulk mode** – Multiple accounts in parallel (useful for friends)
3. **Credential encryption** – AES-256-GCM before MongoDB storage
4. **Multi-meal selection** – Breakfast (1), Lunch (2), Dinner (3)
5. **Dual schedule modes:**
   - **Tomorrow-only** – Single reservation for next day
   - **Auto-daily** – Daily cron at 23:00 Algeria time, reserves next 3 days
6. **Retry logic** – Up to 2 attempts per day if first fails
7. **Residence suggestions** – API-driven lookup with user selection
8. **Restaurant/depot picking** – Interactive inline keyboard selection

#### Environment Variables Required

```bash
# Encryption (REQUIRED for reservation feature)
RESERVE_ENCRYPTION_KEY="your_32_byte_hex_key_or_passphrase"

# Cron job security
CRON_SECRET="secure_token_for_external_trigger"

# Existing bot env vars
TOKEN="your_telegram_bot_token"
MONGO_URI="mongodb+srv://user:pass@cluster.mongodb.net/teleTag"
GEMINI_API_KEY="your_google_api_key"
PROGRES_USERNAME="student_username"
PROGRES_PASSWORD="student_password"
CLASS_GROUP_ID="-1001234567890"  # Telegram group ID for grade notifications
ADMIN_USER_IDS="user_id_1,user_id_2"  # Comma-separated for /reservehealth

# Optional
NODE_ENV="production"
PORT="3000"
```

### Setup Flow (`/reserve`)

#### Step 1: Mode Selection

- **Single account** → One account for one residence
- **Chunk accounts** → Multiple accounts (supports bulk)

#### Step 2a: Single Mode – Credential Entry

```
User: /reserve
Bot: Shows mode keyboard
User: Taps "Single account"
Bot: "Send your WebEtu email/identifier"
User: "student123@example.dz"
Bot: "Send your password"
User: "password123"
Bot: ✓ Validates against WebEtu API
Bot: Encryption stores in MongoDB
Bot: Moves to residence selection
```

#### Step 2b: Chunk Mode – Bulk Credential Entry

```
User: /reserve
Bot: Shows mode keyboard
User: Taps "Chunk accounts"
Bot: "Send credentials (one per line or comma-separated)"
User:
  user1@email.dz:pass1
  user2@email.dz:pass2
  user3@email.dz:pass3
Bot: ✓ Validates each account
Bot: Shows partial failures (if any)
Bot: User can continue with valid or resend
Bot: Moves to residence selection
```

#### Step 3: Residence Selection

```
User: Sees 3 options:
  1. Cite 6 (default) – wilaya 22, residence 0, depot 269
  2. Suggest from API – fetches common residences
  3. Manual – manual wilaya,residence input

Option 1: Immediate move to meal selection
Option 2: Queries WebEtu/ONOU for suggestions (user picks from list)
Option 3: User sends "22,0" or "22,0,269" (auto-discovers depots if no id)
```

#### Step 4: Meal Selection

```
User: Multi-select buttons
  ✅ Breakfast    ✅ Lunch
  ✅ Dinner
  [Select all] [Done]

User: Taps "Done"
Bot: Moves to schedule selection
```

#### Step 5: Schedule Mode

```
User: Chooses:
  1. Tomorrow only – one reservation attempt
  2. Auto daily – daily at 23:00 Algeria time, reserves 3 days ahead

User: Taps one
Bot: Creates profile in MongoDB
Bot: Executes first reservation run
Bot: Sends result summary
```

### Profile Structure (MongoDB `mealReservations` collection)

```javascript
{
  ownerUserId: Number,           // Telegram user ID (unique index)
  ownerChatId: Number,           // Telegram chat ID (for direct messages)
  mode: "single" | "chunk",      // Account mode
  accounts: [
    {
      username: String,
      passwordEncrypted: String   // AES-256-GCM encrypted
    }
  ],
  residence: {
    label: String,
    wilaya: String,
    residence: String,
    idDepot: Number,
    depotLabel: String
  },
  mealTypes: [1, 2, 3],          // Breakfast, Lunch, Dinner
  autoEnabled: Boolean,
  reserveDaysAhead: Number,      // 1 (once) or 3 (auto-daily)
  lastRun: {
    dayKey: "2026-04-27",
    attempt: 1 | 2,
    status: "success" | "partial" | "failed",
    attemptedAt: ISOString,
    successCount: Number,
    failedCount: Number,
    dateStrings: ["2026-04-28", "2026-04-29", "2026-04-30"],
    results: [
      {
        username: String,
        success: Boolean,
        submittedCount: Number,
        skippedAsExisting: Number,
        error: String (if failed)
      }
    ]
  },
  createdAt: ISOString,
  updatedAt: ISOString
}
```

### Onboarding State Machine (MongoDB `mealReservationOnboarding` collection)

Temporary session state during setup:

```javascript
{
  userId: Number,
  ownerChatId: Number,
  step: String,                  // "pick_mode" | "single_username" | "single_password" |
                                 // "chunk_credentials" | "chunk_confirm_partial" |
                                 // "pick_residence" | "manual_residence_input" |
                                 // "pick_meals" | "pick_schedule" | "pick_depot"
  mode: "single" | "chunk" | null,
  accounts: [],
  pendingValidAccounts: [],      // During chunk partial validation
  pendingInvalidAccounts: [],    // Error messages from chunk
  depotCandidates: [],           // Depot options for selection
  residence: Object,
  mealTypes: [1, 2, 3],
  tempUsername: String,          // Temp storage during single flow
  createdAt: ISOString,
  updatedAt: ISOString
}
```

Deleted on:

- Setup completion (`/reservecancel` or final finalization)
- Session expiry (48 hours implicit, no explicit TTL)

### Credential Encryption

**Algorithm:** AES-256-GCM with random IV and authentication tag

**Key Derivation:**

- If `RESERVE_ENCRYPTION_KEY` is 64 hex chars: use as-is (256 bits)
- Otherwise: SHA256 hash of string

**Format:** `{iv_hex}:{tag_hex}:{encrypted_hex}`

**Example:**

```
plaintext: "myPassword123"
encrypted: "a1b2c3d4e5f6:ghijklmn:opqrst..."
decrypted: "myPassword123"
```

**Implementation:**

```javascript
export function encryptSecret(plainText) {
  const key = getEncryptionKeyBuffer();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plainText, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decryptSecret(cipherText) {
  const [ivHex, tagHex, encryptedHex] = cipherText.split(":");
  const key = getEncryptionKeyBuffer();
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
```

### API Integrations

#### WebEtu API

**Base:** `https://api-webetu.mesrs.dz`

**Authentication:**

- Endpoint: `/api/authentication/v1/` (POST)
- Body: `{ "username": "...", "password": "..." }`
- Response: `{ "uuid": "...", "token": "...", "idDia": "...", "idIndividu": "..." }`
- Headers: HMAC-SHA256 signed with secret `pUzHUW2WX54uCzhO8JC2eQ6g1Ol21upw`

**Token Exchange for ONOU:**

- Endpoint: `https://gs-api.onou.dz/api/loginpwebetu?uuid=...&wilaya=...&residence=...&token=...`
- Returns: `{ "token": "onouBearerToken" }`

#### ONOU API

**Base:** `https://gs-api.onou.dz`

**Endpoints:**

1. **Fetch Depots (restaurants):**

   ```
   GET /api/getdepotres?uuid=...&wilaya=...&residence=...&token=...
   Response: { "depots": [{ "idDepot": 269, "depot_fr": "Cite 6" }] }
   ```

2. **Fetch Current Reservations:**

   ```
   GET /api/meal-reservations/student?uuid=...&wilaya=...&residence=...&token=...
   Response: { "data": [{ "date_reserve": "2026-04-28", "menu_type": 2 }] }
   ```

3. **Reserve Meals:**
   ```
   POST /api/reservemeal
   Body: {
     "uuid": "...",
     "wilaya": "22",
     "residence": "0",
     "token": "...",
     "details": ["{\\"date_reserve\\": \\"2026-04-28\\", \\"menu_type\\": 2, \\"idDepot\\": 269}"]
   }
   Response: { "message": "Success" } | { "message": "Error..." }
   ```

**Request Signing:** Same HMAC-SHA256 scheme as WebEtu

### Daily Cron Job (check-reservations.js)

**Trigger:** External HTTP request to `https://your-netlify-domain/.netlify/functions/check-reservations?token=YOUR_CRON_SECRET&force=0`

**Execution Logic:**

```
1. Verify CRON_SECRET token (401 if invalid)
2. Check if current Algeria hour = 23 (skip if not, unless ?force=1)
3. For each profile with autoEnabled=true:
   a. Get lastRun (if today and status=success, skip)
   b. If today and attempt >= 2, skip (no more retries)
   c. Increment attempt counter
   d. Execute reservation for 3 days ahead
   e. Update lastRun with status, attempt, results
   f. Send status message to ownerChatId (if set)
4. Return summary: { totalProfiles, attemptedProfiles, succeededProfiles, failedProfiles }
```

**Response:**

```javascript
{
  success: true,
  dayKey: "2026-04-27",
  totalProfiles: 42,
  attemptedProfiles: 38,
  succeededProfiles: 35,
  failedProfiles: 3,
  skippedProfiles: 4
}
```

**External Trigger Example (using curl):**

```bash
curl "https://your-site.netlify.app/.netlify/functions/check-reservations?token=abc123def456"
```

Or via cron (AWS EventBridge, Google Cloud Scheduler, etc.):

```
Every day at 23:00 UTC+1 (Algeria):
POST https://your-site.netlify.app/.netlify/functions/check-reservations?token=YOUR_CRON_SECRET
```

### User Commands

- `/reserve` – Start setup (private chat only)
- `/reserveedit` – Edit existing profile (restarts onboarding)
- `/reservestatus` – View current profile settings
- `/reservestop` – Disable auto mode (keeps profile)
- `/reservecancel` – Cancel current setup session
- `/reservehealth` – Admin command: show system-wide health snapshot

### Existing Reservation Detection

Before submitting a reservation, the system fetches current reservations and skips any already-booked meals:

```javascript
// Built set of existing reservations: "2026-04-28::2" (date::mealType)
for each dateString and mealType combination:
  if already in existing set:
    mark as skippedAsExisting
  else:
    add to submission payload

// Result summary includes both submittedCount and skippedAsExisting
```

---

## DATABASE SCHEMA

### Collections

| Collection                  | Purpose                         | TTL            |
| --------------------------- | ------------------------------- | -------------- |
| `groupMembers`              | Group member registration       | None           |
| `helpers`                   | Helper team per group           | None           |
| `reminders`                 | Reminders per group             | None           |
| `aiConversations`           | AI chat history (user + group)  | None           |
| `apiUsage`                  | Daily Gemini API request count  | 86400s (1 day) |
| `wheelOptions`              | Saved spinner options per group | None           |
| `grades`                    | Progres API cached grades       | None           |
| `mealReservations`          | Meal reservation profiles       | None           |
| `mealReservationOnboarding` | Onboarding session state        | None           |

### Indexes

Created in `bot.mjs` on initialization:

```javascript
await this.db.collection("groupMembers").createIndex({ chatId: 1 });
await this.db.collection("helpers").createIndex({ chatId: 1 });
await this.db.collection("reminders").createIndex({ chatId: 1 });
await this.db
  .collection("aiConversations")
  .createIndex({ chatId: 1, userId: 1 });
await this.db
  .collection("apiUsage")
  .createIndex({ date: 1 }, { expireAfterSeconds: 86400 });
await this.db.collection("wheelOptions").createIndex({ chatId: 1 });
await this.db
  .collection("mealReservations")
  .createIndex({ ownerUserId: 1 }, { unique: true });
await this.db
  .collection("mealReservationOnboarding")
  .createIndex({ userId: 1 }, { unique: true });
```

---

## DEPLOYMENT & INFRASTRUCTURE

### Netlify Deployment

**netlify.toml Configuration:**

```toml
[build]
  functions = "netlify/functions"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200
```

**Functions Structure:**

```
netlify/functions/
├── bot.mjs                          # Main webhook handler
├── check-reservations.js            # Daily cron function
└── reserve-utils.mjs                # Shared utilities
```

### Local Development

**Start server:**

```bash
npm install
npm start  # runs server.mjs with Express on port 3000
```

**Set webhook locally (for testing):**

```bash
curl -X POST https://api.telegram.org/bot{TOKEN}/setWebhook \
  -F "url=https://your-ngrok-url/webhook"
```

### Production Deployment

1. **Push to GitHub** (if using Netlify Git integration)
2. **Build triggers automatically** on main branch
3. **Webhook URL:** `https://your-site.netlify.app/.netlify/functions/bot`
4. **Set Telegram webhook:**
   ```bash
   curl -X POST https://api.telegram.org/bot{TOKEN}/setWebhook \
     -d url="https://your-site.netlify.app/.netlify/functions/bot"
   ```

### Scaling Considerations

- **Rate limiting:** 10 req/min per user (in-memory map)
- **Caching:** 5-minute TTL for conversation history, group data
- **Database:** MongoDB connection pooling (maxPoolSize: 10)
- **Timeout:** Socket timeout 45s, server selection 5s
- **Concurrency:** Netlify Functions are stateless; each invocation is isolated

---

## ENVIRONMENT VARIABLES

### Required

```bash
# Telegram
TOKEN=                          # Bot token from @BotFather

# Database
MONGO_URI=                      # MongoDB connection string

# AI & APIs
GEMINI_API_KEY=                 # Google Generative AI key
PROGRES_USERNAME=               # Student username for Progres
PROGRES_PASSWORD=               # Student password for Progres

# Encryption
RESERVE_ENCRYPTION_KEY=         # 32-byte hex key or passphrase for AES-256-GCM

# Cron Job
CRON_SECRET=                    # Secret token for check-reservations trigger

# Group Config
CLASS_GROUP_ID=                 # Telegram group ID for grade notifications (e.g., -1001234567890)
ADMIN_USER_IDS=                 # Comma-separated user IDs with admin access (e.g., "123,456,789")
```

### Optional

```bash
NODE_ENV=production             # Set to "development" for verbose logging
PORT=3000                       # Local server port (default: 3000)
```

### Example .env File

```env
TOKEN=123456789:ABCDEFGHIJKLMNopqrstuvwxyz
MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/teleTag?retryWrites=true
GEMINI_API_KEY=AIzaSy...
PROGRES_USERNAME=student.name@univ.dz
PROGRES_PASSWORD=mypassword123
RESERVE_ENCRYPTION_KEY=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4
CRON_SECRET=supersecure_cron_token
CLASS_GROUP_ID=-1001234567890
ADMIN_USER_IDS=123456,789012,345678
NODE_ENV=production
```

---

## API INTEGRATION DETAILS

### Gemini 2.5 Flash Model

**Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`

**Request Format:**

```javascript
{
  contents: [
    {
      parts: [
        { text: "Your prompt here" },
        // Optional multimodal:
        { inline_data: { mime_type: "image/jpeg", data: "base64..." } }
      ]
    }
  ],
  generationConfig: {
    temperature: 0.7,
    topP: 0.9,
    maxOutputTokens: 2048,
    responseMimeType: "text/plain"
  },
  safetySettings: [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    // ... other harm categories
  ]
}
```

**Retry Logic:**

- 3 retries on network errors (TypeError)
- 3 retries on 5xx server errors
- 429 (quota) → returns error immediately
- Exponential backoff: 1000ms between retries

**Supported MIME Types (Multimodal):**

- `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- `application/pdf`
- `text/plain`

### Progres API (Grade Checking)

**Base:** `https://progres.mesrs.dz`

**Login:**

```
POST /api/authentication/v1/
Body: { "username": "...", "password": "..." }
Response: {
  "token": "...",
  "dias": "card_id_1,card_id_2,..."  // Comma-separated IDs
  "expirationDate": "2026-12-31T..."
}
```

Uses most recent card ID from `dias` array.

**Fetch Exam Grades:**

```
GET /api/infos/planningSession/dia/{cardId}/noteExamens
Headers: { "Authorization": "{token}" }
Response: [
  {
    "id": "...",
    "mcLibelleFr": "Module Name",
    "noteExamen": 15.5  // or null if not posted
  }
]
```

**Fetch CC Grades:**

```
GET /api/infos/controleContinue/dia/{cardId}/notesCC
Headers: { "Authorization": "{token}" }
Response: [
  {
    "id": "...",
    "rattachementMcMcLibelleFr": "Module Name",
    "note": 8.0  // or null if not posted
  }
]
```

**Token Refresh:** On 401 response or expiration, re-login automatically

---

## KNOWN ISSUES & BUGFIXES

### Issue #1: MongoDB `createdAt` Field Conflict

**Problem:** When upserting documents with `$setOnInsert`, if a document already exists, the `createdAt` is preserved. However, if a field name clashes with MongoDB reserved operations, insertion could fail.

**Status:** ✅ **FIXED**

**Fix Applied:** In all `upsert` operations for meal reservations, credentials are sanitized before storage:

```javascript
const { _id, createdAt, updatedAt, ...safePayload } = payload || {};
await collection.updateOne(
  { ownerUserId: userId },
  {
    $set: { ...safePayload, ownerUserId, updatedAt: new Date() },
    $setOnInsert: { createdAt: new Date() },
  },
  { upsert: true },
);
```

This prevents accidental override of system-generated timestamps.

### Issue #2: Telegram SSL/HTTPS Verification

**Problem:** Local development with self-signed certificates or internal testing may fail due to SSL verification.

**Status:** ✅ **MITIGATED**

**Implementation:** In `reserve-utils.mjs`:

```javascript
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Disable SSL verification for ONOU/WebEtu
```

⚠️ **WARNING:** This disables SSL verification globally. Only use in development or with trusted internal APIs. For production, ensure proper SSL certificates.

### Issue #3: Rate Limiting Edge Case

**Problem:** Rate limit counter reset could allow brief bursts if multiple requests arrive exactly at window boundary.

**Status:** ⚠️ **ACCEPTED**

**Current Implementation:** Simple in-memory rate limiter with 60-second window. Edge case acknowledged but not a security risk since quota limits are enforced server-side by Gemini API.

### Issue #4: Conversation History Pruning

**Problem:** Storing up to 20 messages per user+group could consume excessive storage over time.

**Status:** ⚠️ **MONITORED**

**Mitigation:** TTL index could be added to `aiConversations` collection to auto-expire old conversations after N days.

### Issue #5: Meal Reservation – Partial Success Notifications

**Problem:** If some accounts succeed and others fail in chunk mode, unclear which accounts failed.

**Status:** ✅ **RESOLVED**

**Solution:** Detailed per-account results are stored in `lastRun.results`:

```javascript
results: [
  { username: "user1@dz", success: true, submittedCount: 3, ... },
  { username: "user2@dz", success: false, error: "Invalid credentials", ... }
]
```

User receives formatted summary listing failed accounts with reasons.

### Issue #6: External Cron Timeout

**Problem:** If `check-reservations` function runs long and times out, daily reservations miss.

**Status:** ⚠️ **MITIGATED**

**Current Approach:**

- Parallel processing could reduce execution time
- Function timeout: Netlify default 10s (functions tier) to 26.5s (pro tier)
- Retry logic: Max 2 attempts, so missed day means 1 day no reservation (not critical)

**Recommendation:** Monitor execution logs and consider async job queue for large user bases.

---

## COMMAND REFERENCE

### Group Management

| Command        | Usage                 | Scope    |
| -------------- | --------------------- | -------- |
| `/join`        | Register in group     | Group/DM |
| `/leave`       | Unregister from group | Group    |
| `/showmembers` | List members          | Group    |
| `/mentionall`  | Tag all members       | Group    |

### Helper System

| Command         | Usage                              | Scope |
| --------------- | ---------------------------------- | ----- |
| `/addtohelp`    | Join helpers                       | Group |
| `/showhelpers`  | List helpers                       | Group |
| `/leavehelpers` | Leave helpers                      | Group |
| `/help`         | Request help (mention all helpers) | Group |

### Reminders

| Command                   | Usage                           | Scope |
| ------------------------- | ------------------------------- | ----- |
| `/setreminder YYYY-MM-DD` | Set reminder (reply to message) | Group |
| `/reminders`              | View active reminders           | Group |
| `/clearreminders`         | Delete all                      | Group |
| `/clearreminder 1,2,5`    | Delete by index                 | Group |

### AI Features

| Command                | Usage                                               | Scope    |
| ---------------------- | --------------------------------------------------- | -------- |
| `/ask <question>`      | Ask AI                                              | Group/DM |
| `/translate`           | Translate (reply to msg, or `/translate to french`) | Group    |
| `/summarize`           | Summarize (reply to msg)                            | Group    |
| `/qcm <topic>`         | Generate 5-question quiz                            | Group    |
| `/solve`               | Solve exercise (reply to file or inline problem)    | Group    |
| `/email <description>` | Generate French email                               | Group    |
| `/clearai`             | Clear conversation history                          | Group    |
| `/credits`             | Show API usage                                      | Group    |

### Games

| Command   | Usage                | Scope |
| --------- | -------------------- | ----- |
| `/games`  | Show game menu       | Group |
| _(Games)_ | Via callback buttons | Group |

### Grade Checking

| Command  | Usage                         | Scope |
| -------- | ----------------------------- | ----- |
| `/check` | Manually check for new grades | Group |

### Meal Reservation

| Command          | Usage                  | Scope                 |
| ---------------- | ---------------------- | --------------------- |
| `/reserve`       | Setup meal reservation | DM only               |
| `/reserveedit`   | Edit profile           | DM only               |
| `/reservestatus` | View profile           | Group/DM              |
| `/reservestop`   | Disable auto mode      | DM only               |
| `/reservecancel` | Cancel setup session   | DM only               |
| `/reservehealth` | Admin health snapshot  | Group/DM (admin only) |

### Wheel/Spinner

| Command                   | Usage              | Scope |
| ------------------------- | ------------------ | ----- |
| `/wheel opt1, opt2, opt3` | Spin inline        | Group |
| `/wheel`                  | Spin saved wheel   | Group |
| `/wheeladd <option>`      | Add to saved       | Group |
| `/wheelremove <index>`    | Remove by position | Group |
| `/wheelshow`              | List options       | Group |

### Admin/System

| Command  | Usage                | Scope              |
| -------- | -------------------- | ------------------ |
| `/start` | Start message        | DM                 |
| `/help`  | Full command list    | Group/DM           |
| `/reset` | Clear all group data | Group (dangerous!) |

---

## FUTURE ROADMAP

### Planned (In Backlog)

1. **Per-account inline retry actions** – Allow users to retry failed reservation accounts directly from Telegram message without re-running full profile
2. **Profile export/import** – Backup/migrate reservation configuration (encrypted JSON export)
3. **Async job queue** – Replace external cron with internal queue for reliability
4. **Meal preference templates** – Save and apply common meal combinations (breakfast-only, lunch-dinner, etc.)
5. **Multiple residences** – Support switching between different residence/depot configs
6. **Group-level reservations** – Admin commands to manage reservations for entire group

### Deferred Features

- Webhook signature verification (Telegram provides this)
- Rate limit dashboard
- Reservation history archive
- WhatsApp/Discord bridge

---

## DEBUGGING & TROUBLESHOOTING

### Reservation Setup Not Starting

**Symptom:** User sends `/reserve` but gets no response

**Checks:**

1. Private chat? Reservation is DM-only
2. Encryption key configured? Check `RESERVE_ENCRYPTION_KEY` env var
3. Database connected? Check MongoDB URI and network connectivity
4. Bot token valid? Verify `TOKEN` env var

### Failed Credential Verification

**Symptom:** Single account shows "not valid" after password entry

**Likely causes:**

- WebEtu credentials incorrect
- WebEtu API down (temporarily)
- Network timeout (increase retry count in CONFIG)

**Debug:** Check bot logs for WebEtu response status

### Cron Job Not Running

**Symptom:** Auto reservations not happening at 23:00

**Checks:**

1. External service calling webhook? Verify cron trigger is configured
2. CRON_SECRET token correct?
3. Check function logs in Netlify dashboard
4. Force run: `?token=X&force=1` to test outside of 23:00

### Partial Meal Reservation Success

**Symptom:** Some meals booked, some skipped as "already reserved"

**Expected behavior:** System auto-detects existing reservations and skips. No action needed.

**If concerned:** Check MongoDB `mealReservations` collection for `lastRun.results` detail.

### API Quota Exceeded

**Symptom:** Gemini API returns 429 with "quota exceeded"

**Solution:** Check Google AI Studio console for quota limits and upgrade tier if needed.

---

## SUPPORT & CONTACT

For issues, questions, or contributions:

- Review [reservation-backlog.md](./features/notes/scaling-ideas.md) for future plans
- Check bot logs: `node server.mjs` (local) or Netlify dashboard (production)
- Validate environment variables match `.env.example`

---

**Document Version:** 1.0.0  
**Last Updated:** April 27, 2026  
**Maintained By:** TeleTag Development Team
