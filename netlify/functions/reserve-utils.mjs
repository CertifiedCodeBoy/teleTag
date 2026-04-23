import crypto from "node:crypto";

// Disable SSL verification for ONOU API (equivalent to Python's verify=False)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export const WEBETU_BASE = "https://api-webetu.mesrs.dz";
export const ONOU_BASE = "https://gs-api.onou.dz";
export const HMAC_SECRET = "pUzHUW2WX54uCzhO8JC2eQ6g1Ol21upw";

export const DEFAULT_RESIDENCE = {
  label: "Cite 6",
  wilaya: "22",
  residence: "0",
  idDepot: 269,
  depotLabel: "Cite 6",
};

export const MEAL_OPTIONS = {
  1: "Breakfast",
  2: "Lunch",
  3: "Dinner",
};

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toAlgeriaDate(date = new Date()) {
  const local = new Date(
    date.toLocaleString("en-US", { timeZone: "Africa/Algiers" }),
  );
  return local;
}

export function getAlgeriaDateKey(date = new Date()) {
  const algeria = toAlgeriaDate(date);
  const year = algeria.getFullYear();
  const month = String(algeria.getMonth() + 1).padStart(2, "0");
  const day = String(algeria.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildReservationDates(daysAhead = 1) {
  const base = toAlgeriaDate();
  const dates = [];
  for (let i = 1; i <= daysAhead; i++) {
    const next = new Date(base);
    next.setDate(base.getDate() + i);
    const year = next.getFullYear();
    const month = String(next.getMonth() + 1).padStart(2, "0");
    const day = String(next.getDate()).padStart(2, "0");
    dates.push(`${year}-${month}-${day}`);
  }
  return dates;
}

export function hasEncryptionKey() {
  return Boolean(process.env.RESERVE_ENCRYPTION_KEY);
}

function getEncryptionKeyBuffer() {
  const raw = process.env.RESERVE_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("RESERVE_ENCRYPTION_KEY is not configured");
  }

  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function encryptSecret(plainText) {
  if (typeof plainText !== "string" || plainText.length === 0) {
    throw new Error("Cannot encrypt empty secret");
  }

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
  if (typeof cipherText !== "string" || cipherText.length === 0) {
    throw new Error("Cannot decrypt empty secret");
  }

  const parts = cipherText.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted payload format");
  }

  const [ivHex, tagHex, encryptedHex] = parts;
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

function signRequest(body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const signingString = `${timestamp}|${nonce}|${body}`;
  const signature = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update(signingString, "utf8")
    .digest("hex");

  return { timestamp, nonce, signature };
}

export function createWebEtuHeaders({
  token = null,
  body = "",
  idDia = null,
  idIndividu = null,
} = {}) {
  const { timestamp, nonce, signature } = signRequest(body);
  const headers = {
    "Content-Type": "application/json",
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": signature,
    "User-Agent": "okhttp/4.9.2",
  };

  if (token) {
    headers.authorization = token;
  }
  if (idDia) {
    headers["X-DIA-ID"] = String(idDia);
  }
  if (idIndividu) {
    headers["X-IND-ID"] = String(idIndividu);
  }

  return headers;
}

export function createOnouHeaders({ onouToken = null, body = "" } = {}) {
  const { timestamp, nonce, signature } = signRequest(body);
  const headers = {
    "Content-Type": "application/json",
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": signature,
    "User-Agent": "okhttp/4.9.2",
  };

  if (onouToken) {
    headers.authorization = `Bearer ${onouToken}`;
  }

  return headers;
}

function extractJsonField(data, paths) {
  for (const path of paths) {
    const keys = path.split(".");
    let current = data;
    let valid = true;
    for (const key of keys) {
      if (current == null || !(key in current)) {
        valid = false;
        break;
      }
      current = current[key];
    }
    if (valid && current != null) {
      return current;
    }
  }
  return null;
}

export function maskIdentifier(value = "") {
  const v = String(value || "").trim();
  if (!v) return "unknown";
  if (v.length <= 4) return "****";
  return `${v.slice(0, 2)}***${v.slice(-2)}`;
}

export async function authenticateWebEtu(username, password) {
  console.log('[RESERVE] authenticateWebEtu START', { username });
  const loginBody = JSON.stringify({ username, password });

  try {
    const response = await fetch(`${WEBETU_BASE}/api/authentication/v1/`, {
      method: "POST",
      headers: createWebEtuHeaders({ body: loginBody }),
      body: loginBody,
    });

    const raw = await response.text();
    const data = safeJsonParse(raw, {});
    console.log('[RESERVE] authenticateWebEtu response', { status: response.status, ok: response.ok });

    if (!response.ok) {
      console.log('[RESERVE] authenticateWebEtu FAILED', { status: response.status, error: data?.message || raw });
      return {
        ok: false,
        status: response.status,
        error:
          data?.message || raw || `WebEtu login failed (${response.status})`,
      };
    }

    const uuid = extractJsonField(data, ["uuid", "data.uuid"]);
    const token = extractJsonField(data, ["token", "data.token"]);
    const idIndividu = extractJsonField(data, [
      "idIndividu",
      "data.idIndividu",
    ]);
    const idDia = extractJsonField(data, ["idDia", "data.idDia"]);

    if (!uuid || !token) {
      console.log('[RESERVE] authenticateWebEtu FAILED - missing uuid/token');
      return {
        ok: false,
        status: response.status,
        error: "WebEtu login response missing uuid/token",
      };
    }

    console.log('[RESERVE] authenticateWebEtu SUCCESS', { uuid, idIndividu, idDia });
    return {
      ok: true,
      status: response.status,
      uuid,
      token,
      idIndividu: idIndividu ? String(idIndividu) : null,
      idDia: idDia ? String(idDia) : null,
      rawData: data,
    };
  } catch (error) {
    console.log('[RESERVE] authenticateWebEtu EXCEPTION', { error: error.message, cause: error.cause?.message || error.cause?.code || String(error.cause || '') });
    return {
      ok: false,
      status: 0,
      error: error.message || "Network error while logging into WebEtu",
    };
  }
}

export async function exchangeOnouToken({
  uuid,
  webetuToken,
  wilaya,
  residence,
  idIndividu = null,
  idDia = null,
}) {
  console.log('[RESERVE] exchangeOnouToken START', { uuid, wilaya, residence });
  try {
    const url = new URL(`${ONOU_BASE}/api/loginpwebetu`);
    url.searchParams.set("uuid", String(uuid));
    url.searchParams.set("wilaya", String(wilaya));
    url.searchParams.set("residence", String(residence));
    url.searchParams.set("token", String(webetuToken));

    const response = await fetch(url, {
      method: "POST",
      headers: createWebEtuHeaders({
        token: webetuToken,
        idIndividu,
        idDia,
      }),
    });

    const raw = await response.text();
    const data = safeJsonParse(raw, {});
    console.log('[RESERVE] exchangeOnouToken response', { status: response.status, ok: response.ok });

    if (!response.ok) {
      console.log('[RESERVE] exchangeOnouToken FAILED', { status: response.status, error: data?.message || raw });
      return {
        ok: false,
        status: response.status,
        error:
          data?.message ||
          raw ||
          `ONOU token exchange failed (${response.status})`,
      };
    }

    const onouToken =
      extractJsonField(data, [
        "token",
        "access_token",
        "data.access_token",
        "data.token",
      ]) || null;

    if (!onouToken) {
      console.log('[RESERVE] exchangeOnouToken FAILED - no token in response');
      return {
        ok: false,
        status: response.status,
        error: "ONOU token missing from exchange response",
      };
    }

    console.log('[RESERVE] exchangeOnouToken SUCCESS');
    return {
      ok: true,
      status: response.status,
      onouToken,
      rawData: data,
    };
  } catch (error) {
    console.log('[RESERVE] exchangeOnouToken EXCEPTION', { error: error.message, cause: error.cause?.message || error.cause?.code || String(error.cause || '') });
    return {
      ok: false,
      status: 0,
      error: error.message || "Network error while exchanging ONOU token",
    };
  }
}

function normalizeDepotItem(item) {
  const idDepot =
    item?.idDepot ??
    item?.depotId ??
    item?.id ??
    item?.id_depot ??
    item?.depot?.id ??
    null;

  const depotLabel =
    item?.depot_fr ||
    item?.depot_ar ||
    item?.nomDepot ||
    item?.name ||
    item?.libelle ||
    item?.label ||
    item?.depot?.name ||
    item?.depot?.libelle ||
    "Unknown depot";

  if (!idDepot) {
    return null;
  }

  return {
    idDepot: Number(idDepot),
    depotLabel: String(depotLabel).trim(),
  };
}

export function normalizeDepots(rawData) {
  let source = [];

  if (Array.isArray(rawData)) {
    source = rawData;
  } else if (Array.isArray(rawData?.depots)) {
    source = rawData.depots;
  } else if (rawData && typeof rawData === "object") {
    source = [rawData];
  }

  const depots = [];
  const seen = new Set();

  for (const item of source) {
    const normalized = normalizeDepotItem(item);
    if (!normalized) continue;

    const key = `${normalized.idDepot}`;
    if (seen.has(key)) continue;

    seen.add(key);
    depots.push(normalized);
  }

  return depots;
}

export async function fetchDepots({ uuid, onouToken, wilaya, residence }) {
  console.log('[RESERVE] fetchDepots START', { wilaya, residence });
  try {
    const url = new URL(`${ONOU_BASE}/api/getdepotres`);
    url.searchParams.set("uuid", String(uuid));
    url.searchParams.set("wilaya", String(wilaya));
    url.searchParams.set("residence", String(residence));
    url.searchParams.set("token", String(onouToken));

    const response = await fetch(url, {
      method: "GET",
      headers: createOnouHeaders({ onouToken }),
    });

    const raw = await response.text();
    const data = safeJsonParse(raw, null);
    console.log('[RESERVE] fetchDepots response', { status: response.status, ok: response.ok });

    if (!response.ok) {
      console.log('[RESERVE] fetchDepots FAILED', { status: response.status, error: raw });
      return {
        ok: false,
        status: response.status,
        error: raw || `Failed to fetch depots (${response.status})`,
        depots: [],
      };
    }

    const depots = normalizeDepots(data);
    console.log('[RESERVE] fetchDepots SUCCESS', { depotCount: depots.length });
    return {
      ok: true,
      status: response.status,
      depots,
      rawData: data,
    };
  } catch (error) {
    console.log('[RESERVE] fetchDepots EXCEPTION', { error: error.message });
    return {
      ok: false,
      status: 0,
      error: error.message || "Network error while fetching depots",
      depots: [],
    };
  }
}

export async function fetchCurrentReservations({
  uuid,
  onouToken,
  wilaya,
  residence,
}) {
  console.log('[RESERVE] fetchCurrentReservations START', { wilaya, residence });
  try {
    const url = new URL(`${ONOU_BASE}/api/meal-reservations/student`);
    url.searchParams.set("uuid", String(uuid));
    url.searchParams.set("wilaya", String(wilaya));
    url.searchParams.set("residence", String(residence));
    url.searchParams.set("token", String(onouToken));

    const response = await fetch(url, {
      method: "GET",
      headers: createOnouHeaders({ onouToken }),
    });

    const raw = await response.text();
    const data = safeJsonParse(raw, {});

    if (!response.ok) {
      console.log('[RESERVE] fetchCurrentReservations FAILED', { status: response.status });
      return {
        ok: false,
        status: response.status,
        error:
          data?.message ||
          raw ||
          `Failed to fetch reservations (${response.status})`,
        reservations: [],
      };
    }

    const reservations = Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];

    console.log('[RESERVE] fetchCurrentReservations SUCCESS', { count: reservations.length });
    return {
      ok: true,
      status: response.status,
      reservations,
      rawData: data,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.message || "Network error while fetching reservations",
      reservations: [],
    };
  }
}

function mealTypeFromReservation(item) {
  const direct =
    item?.menu_type ?? item?.menuType ?? item?.meal_type ?? item?.mealType;
  const parsed = Number(direct);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 3) {
    return parsed;
  }

  const label = String(
    item?.mealtype_fr || item?.mealtype || item?.meal || "",
  ).toLowerCase();
  if (!label) return null;

  if (label.includes("petit") || label.includes("break")) return 1;
  if (label.includes("déj") || label.includes("dej") || label.includes("lunch"))
    return 2;
  if (label.includes("din") || label.includes("soir")) return 3;

  return null;
}

function reservationKey(dateString, mealType) {
  return `${dateString}::${mealType}`;
}

function normalizeDateValue(value) {
  if (!value) return null;
  const text = String(value);
  return text.length >= 10 ? text.slice(0, 10) : text;
}

function buildExistingReservationSet(reservations = []) {
  const set = new Set();
  for (const item of reservations) {
    const dateString = normalizeDateValue(
      item?.date_reserve || item?.dateReserve || item?.date,
    );
    const mealType = mealTypeFromReservation(item);
    if (!dateString || !mealType) continue;
    set.add(reservationKey(dateString, mealType));
  }
  return set;
}

export async function reserveMeals({
  uuid,
  onouToken,
  wilaya,
  residence,
  idDepot,
  dateStrings,
  mealTypes,
  existingReservations = [],
}) {
  console.log('[RESERVE] reserveMeals START', { idDepot, dateStrings, mealTypes, existingCount: existingReservations.length });
  const existingSet = buildExistingReservationSet(existingReservations);

  const detailObjects = [];
  for (const dateString of dateStrings) {
    for (const mealType of mealTypes) {
      const key = reservationKey(dateString, mealType);
      if (existingSet.has(key)) continue;
      detailObjects.push({
        date_reserve: dateString,
        menu_type: mealType,
        idDepot,
      });
    }
  }

  if (detailObjects.length === 0) {
    console.log('[RESERVE] reserveMeals - everything already reserved');
    return {
      ok: true,
      status: 200,
      submittedCount: 0,
      skippedAsExisting: dateStrings.length * mealTypes.length,
      responseBody: { message: "Everything already reserved" },
    };
  }

  const payload = {
    uuid,
    wilaya: String(wilaya),
    residence: String(residence),
    token: onouToken,
    details: detailObjects.map((obj) => JSON.stringify(obj)),
  };

  const payloadJson = JSON.stringify(payload);

  try {
    const response = await fetch(`${ONOU_BASE}/api/reservemeal`, {
      method: "POST",
      headers: createOnouHeaders({ onouToken, body: payloadJson }),
      body: payloadJson,
    });

    const raw = await response.text();
    const data = safeJsonParse(raw, { raw });
    console.log('[RESERVE] reserveMeals response', { status: response.status, ok: response.ok, detailCount: detailObjects.length });

    if (!response.ok) {
      console.log('[RESERVE] reserveMeals FAILED', { status: response.status, error: data?.message || raw });
      return {
        ok: false,
        status: response.status,
        submittedCount: detailObjects.length,
        skippedAsExisting:
          dateStrings.length * mealTypes.length - detailObjects.length,
        error:
          data?.message || raw || `Reservation failed (${response.status})`,
        responseBody: data,
      };
    }

    console.log('[RESERVE] reserveMeals SUCCESS', { submittedCount: detailObjects.length });
    return {
      ok: true,
      status: response.status,
      submittedCount: detailObjects.length,
      skippedAsExisting:
        dateStrings.length * mealTypes.length - detailObjects.length,
      responseBody: data,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      submittedCount: detailObjects.length,
      skippedAsExisting:
        dateStrings.length * mealTypes.length - detailObjects.length,
      error: error.message || "Network error while reserving meals",
      responseBody: null,
    };
  }
}

export function parseChunkCredentials(inputText) {
  if (typeof inputText !== "string") {
    return { validEntries: [], invalidEntries: ["Invalid input"] };
  }

  const parts = inputText
    .split(/\r?\n|,/g)
    .map((part) => part.trim())
    .filter(Boolean);

  const validEntries = [];
  const invalidEntries = [];

  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx <= 0 || idx >= part.length - 1) {
      invalidEntries.push(part);
      continue;
    }

    const username = part.slice(0, idx).trim();
    const password = part.slice(idx + 1).trim();

    if (!username || !password) {
      invalidEntries.push(part);
      continue;
    }

    validEntries.push({ username, password });
  }

  return { validEntries, invalidEntries };
}

export async function fetchResidenceSuggestions({
  username,
  password,
  wilaya = "22",
  maxSuggestions = 8,
}) {
  console.log('[RESERVE] fetchResidenceSuggestions START', { username, wilaya, maxSuggestions });
  const auth = await authenticateWebEtu(username, password);
  if (!auth.ok) {
    return {
      ok: false,
      error: auth.error,
      suggestions: [],
    };
  }

  const residenceCandidates = [
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "11",
  ];

  const suggestions = [];
  for (const residence of residenceCandidates) {
    const onou = await exchangeOnouToken({
      uuid: auth.uuid,
      webetuToken: auth.token,
      wilaya,
      residence,
      idIndividu: auth.idIndividu,
      idDia: auth.idDia,
    });

    if (!onou.ok) continue;

    const depotsResult = await fetchDepots({
      uuid: auth.uuid,
      onouToken: onou.onouToken,
      wilaya,
      residence,
    });

    if (!depotsResult.ok || depotsResult.depots.length === 0) continue;

    for (const depot of depotsResult.depots) {
      suggestions.push({
        label: `${depot.depotLabel} (Res ${residence})`,
        wilaya,
        residence,
        idDepot: depot.idDepot,
        depotLabel: depot.depotLabel,
      });

      if (suggestions.length >= maxSuggestions) {
        return { ok: true, suggestions };
      }
    }
  }

  console.log('[RESERVE] fetchResidenceSuggestions DONE', { suggestionsFound: suggestions.length });
  return {
    ok: suggestions.length > 0,
    suggestions,
    error:
      suggestions.length === 0
        ? "No residence suggestions returned from API"
        : null,
  };
}

export async function executeReservationForAccounts(
  profile,
  { daysAhead = 1 } = {},
) {
  console.log('[RESERVE] executeReservationForAccounts START', { accountCount: profile.accounts?.length, daysAhead });
  const dateStrings = buildReservationDates(daysAhead);
  const mealTypes =
    Array.isArray(profile.mealTypes) && profile.mealTypes.length > 0
      ? profile.mealTypes
      : [1, 2, 3];

  const residence = profile.residence || DEFAULT_RESIDENCE;
  const wilaya = String(residence.wilaya || DEFAULT_RESIDENCE.wilaya);
  const residenceCode = String(
    residence.residence || DEFAULT_RESIDENCE.residence,
  );
  const configuredDepotId = Number(
    residence.idDepot || DEFAULT_RESIDENCE.idDepot,
  );

  const results = [];

  for (const account of profile.accounts || []) {
    const username = account.username;
    console.log('[RESERVE] processing account', { username });
    try {
      const password = decryptSecret(account.passwordEncrypted);

      const auth = await authenticateWebEtu(username, password);
      if (!auth.ok) {
        results.push({
          username,
          success: false,
          stage: "webetu_login",
          error: auth.error,
        });
        continue;
      }

      const onou = await exchangeOnouToken({
        uuid: auth.uuid,
        webetuToken: auth.token,
        wilaya,
        residence: residenceCode,
        idIndividu: auth.idIndividu,
        idDia: auth.idDia,
      });

      if (!onou.ok) {
        results.push({
          username,
          success: false,
          stage: "onou_exchange",
          error: onou.error,
        });
        continue;
      }

      let idDepot = configuredDepotId;
      let depotLabel = residence.depotLabel || DEFAULT_RESIDENCE.depotLabel;

      if (!idDepot) {
        const depotsResult = await fetchDepots({
          uuid: auth.uuid,
          onouToken: onou.onouToken,
          wilaya,
          residence: residenceCode,
        });

        if (!depotsResult.ok || depotsResult.depots.length === 0) {
          results.push({
            username,
            success: false,
            stage: "depot_lookup",
            error: depotsResult.error || "No depots found for this residence",
          });
          continue;
        }

        idDepot = depotsResult.depots[0].idDepot;
        depotLabel = depotsResult.depots[0].depotLabel;
      }

      const current = await fetchCurrentReservations({
        uuid: auth.uuid,
        onouToken: onou.onouToken,
        wilaya,
        residence: residenceCode,
      });

      const reservationResult = await reserveMeals({
        uuid: auth.uuid,
        onouToken: onou.onouToken,
        wilaya,
        residence: residenceCode,
        idDepot,
        dateStrings,
        mealTypes,
        existingReservations: current.ok ? current.reservations : [],
      });

      if (!reservationResult.ok) {
        results.push({
          username,
          success: false,
          stage: "reserve_meals",
          error: reservationResult.error,
          submittedCount: reservationResult.submittedCount || 0,
          skippedAsExisting: reservationResult.skippedAsExisting || 0,
        });
        continue;
      }

      results.push({
        username,
        success: true,
        stage: "completed",
        submittedCount: reservationResult.submittedCount || 0,
        skippedAsExisting: reservationResult.skippedAsExisting || 0,
        idDepot,
        depotLabel,
      });
      console.log('[RESERVE] account completed successfully', { username, submitted: reservationResult.submittedCount, skipped: reservationResult.skippedAsExisting });
    } catch (error) {
      results.push({
        username,
        success: false,
        stage: "unexpected",
        error: error.message || "Unexpected error",
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.length - successCount;

  const overallStatus =
    failedCount === 0 ? "success" : successCount === 0 ? "failed" : "partial";

  console.log('[RESERVE] executeReservationForAccounts DONE', { overallStatus, successCount, failedCount });
  return {
    overallStatus,
    successCount,
    failedCount,
    dateStrings,
    mealTypes,
    results,
  };
}
