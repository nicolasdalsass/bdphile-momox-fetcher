const ext = globalThis.browser ?? globalThis.chrome;
const cache = globalThis.BdphileMomoxCache;

const MOMOX_API_URL = "https://api.momox.de/api/v4/media/offer/";
const MOMOX_MARKETPLACE = "momox_fr";
const MOMOX_CLIENT_VERSION = "r5299-76accf6";
const DEFAULT_MOMOX_API_TOKEN = "2231443b8fb511c7b6a0eb25a62577320bac69b6";

const BDPHILE_ORIGIN = "https://www.bdphile.fr";
const EAN_BLOCK_RE =
  /<dt>\s*EAN\s*<\/dt>\s*<dd>\s*([\d\s-]+)\s*<\/dd>/i;

const MOMOX_MIN_INTERVAL_MS = 10000;
const MOMOX_429_MAX_RETRIES = 2;
const MOMOX_429_BASE_DELAY_MS = 4000;
/** After 429/403, stop all Momox calls until this cooldown elapses. */
const MOMOX_COOLDOWN_DEFAULT_MS = 60 * 60 * 1000;
const MOMOX_WORK_QUEUE_KEY = "momoxPendingQueue";
const BDPHILE_ALBUM_QUEUE_KEY = "bdphilePendingAlbums";
const MOMOX_WORK_ALARM = "momoxQueueTick";
const MOMOX_WORK_BATCH_SIZE = 3;

const FETCH_HEADERS = {
  Accept: "application/json, text/html, */*",
  "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
};

/** @type {Map<string, Promise<object>>} */
const momoxInflight = new Map();
/** @type {Map<string, Promise<object>>} */
const bdphileInflight = new Map();

let momoxQueue = Promise.resolve();
let lastMomoxRequestAt = 0;
let queueTickRunning = false;
let momoxFetchInProgress = false;
const extAction = ext.action ?? ext.browserAction;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeEan(raw) {
  const digits = raw.replace(/\D/g, "");
  return digits.length === 13 ? digits : null;
}

function parseEanFromHtml(html) {
  const match = html.match(EAN_BLOCK_RE);
  return match ? normalizeEan(match[1]) : null;
}

function getMomoxApiToken() {
  return DEFAULT_MOMOX_API_TOKEN;
}

function runOnMomoxQueue(task) {
  const run = momoxQueue.then(task);
  momoxQueue = run.catch(() => {});
  return run;
}

async function getMomoxCooldownUntil() {
  const stored = await ext.storage.local.get("momoxCooldownUntil");
  return stored.momoxCooldownUntil ?? 0;
}

async function setMomoxCooldown(durationMs = MOMOX_COOLDOWN_DEFAULT_MS) {
  const until = Date.now() + durationMs;
  await ext.storage.local.set({ momoxCooldownUntil: until });
  return until;
}

async function clearMomoxCooldown() {
  await ext.storage.local.remove("momoxCooldownUntil");
}

async function getPendingQueueMap() {
  const stored = await ext.storage.local.get(MOMOX_WORK_QUEUE_KEY);
  return stored[MOMOX_WORK_QUEUE_KEY] ?? {};
}

async function savePendingQueueMap(queueMap) {
  await ext.storage.local.set({ [MOMOX_WORK_QUEUE_KEY]: queueMap });
  await updateActionBadge();
}

async function getPendingAlbumMap() {
  const stored = await ext.storage.local.get(BDPHILE_ALBUM_QUEUE_KEY);
  return stored[BDPHILE_ALBUM_QUEUE_KEY] ?? {};
}

async function savePendingAlbumMap(queueMap) {
  await ext.storage.local.set({ [BDPHILE_ALBUM_QUEUE_KEY]: queueMap });
  await updateActionBadge();
}

async function enqueueAlbumIds(albumIds) {
  if (!Array.isArray(albumIds) || !albumIds.length) return;
  const queueMap = await getPendingAlbumMap();
  const now = Date.now();
  for (const albumId of albumIds) {
    if (!albumId || queueMap[albumId]) continue;
    queueMap[albumId] = { addedAt: now };
  }
  await savePendingAlbumMap(queueMap);
}

async function enqueueEanForFetch(ean) {
  if (!ean) return;
  const queueMap = await getPendingQueueMap();
  if (queueMap[ean]) return;
  queueMap[ean] = { attempts: 0, nextAttemptAt: Date.now(), lastError: "" };
  await savePendingQueueMap(queueMap);
}

async function markEanFetchSuccess(ean) {
  const queueMap = await getPendingQueueMap();
  if (!queueMap[ean]) return;
  delete queueMap[ean];
  await savePendingQueueMap(queueMap);
}

async function markEanFetchFailure(ean, error, pausedUntil) {
  const queueMap = await getPendingQueueMap();
  const previous = queueMap[ean] ?? { attempts: 0, nextAttemptAt: Date.now(), lastError: "" };
  const attempts = previous.attempts + 1;
  const baseDelay = Math.min(30 * 60 * 1000, 15_000 * Math.pow(2, Math.min(attempts, 8)));
  const jitter = Math.floor(Math.random() * 1500);
  const nextAttemptAt = Math.max(Date.now() + baseDelay + jitter, pausedUntil ?? 0);
  queueMap[ean] = {
    attempts,
    nextAttemptAt,
    lastError: error instanceof Error ? error.message : String(error ?? ""),
  };
  await savePendingQueueMap(queueMap);
}

async function updateActionBadge() {
  if (!extAction?.setBadgeText) return;
  const queueMap = await getPendingQueueMap();
  const queueItems = Object.values(queueMap);
  const pending = queueItems.length;
  const pause = await getMomoxPauseState();
  const isPaused = Boolean(pause);
  const now = Date.now();
  const readyCount = queueItems.filter(
    (item) => (item?.nextAttemptAt ?? 0) <= now
  ).length;
  const earliestNextAttemptAt = queueItems.reduce((min, item) => {
    const ts = item?.nextAttemptAt ?? now;
    return Math.min(min, ts);
  }, Number.POSITIVE_INFINITY);
  const hasFutureRetries =
    pending > 0 &&
    Number.isFinite(earliestNextAttemptAt) &&
    earliestNextAttemptAt > now;
  const nextRetryMins = hasFutureRetries
    ? Math.max(1, Math.ceil((earliestNextAttemptAt - now) / 60000))
    : 0;

  const text = isPaused
    ? "Zz"
    : pending > 0
      ? String(Math.min(pending, 99))
      : "";
  await extAction.setBadgeText({ text });
  await extAction.setBadgeBackgroundColor({
    color: isPaused ? "#9b1c1c" : momoxFetchInProgress ? "#2563eb" : "#1a7f37",
  });
  if (extAction.setTitle) {
    let statusLine = "IDLE_EMPTY";
    if (isPaused) {
      const mins = Math.ceil((pause.remainingMs ?? 0) / 60000);
      statusLine = `SLEEPING_COOLDOWN (~${Math.max(mins, 0)} min)`;
    } else if (momoxFetchInProgress) {
      statusLine = "ACTIVE_FETCH";
    } else if (pending > 0 && readyCount > 0) {
      statusLine = `QUEUED_WAIT (${readyCount} pret)`;
    } else if (hasFutureRetries) {
      statusLine = `QUEUED_RETRY_AT (~${nextRetryMins} min)`;
    } else if (pending > 0) {
      statusLine = "QUEUED_WAIT";
    }
    await extAction.setTitle({
      title: `Bdphile Momox\nEtat: ${statusLine}\nEAN en attente: ${pending}`,
    });
  }
}

async function getMomoxPauseState() {
  const until = await getMomoxCooldownUntil();
  if (Date.now() >= until) return null;
  return { until, remainingMs: until - Date.now() };
}

async function waitForMomoxSlot() {
  const elapsed = Date.now() - lastMomoxRequestAt;
  if (elapsed < MOMOX_MIN_INTERVAL_MS) {
    await sleep(MOMOX_MIN_INTERVAL_MS - elapsed);
  }
  lastMomoxRequestAt = Date.now();
}

async function fetchWithCookies(url, init = {}) {
  const headers = { ...FETCH_HEADERS, ...init.headers };

  return fetch(url, {
    ...init,
    credentials: "include",
    headers,
  });
}

async function requestMomoxOfferOnce(ean, token) {
  const url = `${MOMOX_API_URL}?ean=${encodeURIComponent(ean)}`;
  const response = await fetch(url, {
    credentials: "omit",
    headers: {
      Accept: "application/json",
      "X-API-TOKEN": token,
      "X-MARKETPLACE-ID": MOMOX_MARKETPLACE,
      "X-CLIENT-VERSION": MOMOX_CLIENT_VERSION,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    err.retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.replace(/\s+/g, " ").slice(0, 80);
    throw new Error(`réponse invalide (${snippet})`);
  }
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);
  if (!Number.isNaN(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

async function requestMomoxOffer(ean, token) {
  let lastError;

  for (let attempt = 0; attempt <= MOMOX_429_MAX_RETRIES; attempt++) {
    try {
      return await requestMomoxOfferOnce(ean, token);
    } catch (error) {
      lastError = error;
      const status = error?.status;
      if (status !== 429 || attempt === MOMOX_429_MAX_RETRIES) {
        throw error;
      }
      const delay =
        error.retryAfterMs ??
        MOMOX_429_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  throw lastError;
}

function isMomoxThrottleStatus(status) {
  return status === 429 || status === 403;
}

async function fetchMomoxOfferData(ean) {
  const hit = await cache.readMomox(ean);
  if (hit) {
    return { offer: hit.data, fromCache: true, cachedAt: hit.fetchedAt, cacheAge: hit.ageLabel };
  }

  const pause = await getMomoxPauseState();
  if (pause) {
    const err = new Error("Momox en pause (trop de requêtes récentes)");
    err.paused = true;
    err.pausedUntil = pause.until;
    throw err;
  }

  let pending = momoxInflight.get(ean);
  if (!pending) {
    pending = runOnMomoxQueue(async () => {
      const again = await cache.readMomox(ean);
      if (again) {
        return { offer: again.data, fromCache: true, cachedAt: again.fetchedAt, cacheAge: again.ageLabel };
      }

      const pauseNow = await getMomoxPauseState();
      if (pauseNow) {
        const err = new Error("Momox en pause (trop de requêtes récentes)");
        err.paused = true;
        err.pausedUntil = pauseNow.until;
        throw err;
      }

      await waitForMomoxSlot();
      const token = getMomoxApiToken();
      try {
        momoxFetchInProgress = true;
        await updateActionBadge();
        const data = await requestMomoxOffer(ean, token);
        await cache.writeMomox(ean, data);
        await markEanFetchSuccess(ean);
        return { offer: data, fromCache: false };
      } catch (firstError) {
        if (isMomoxThrottleStatus(firstError?.status)) {
          const cooldown =
            firstError.retryAfterMs ?? MOMOX_COOLDOWN_DEFAULT_MS;
          await setMomoxCooldown(cooldown);
          await markEanFetchFailure(ean, firstError, Date.now() + cooldown);
          throw firstError;
        }
        await markEanFetchFailure(ean, firstError);
        throw firstError;
      } finally {
        momoxFetchInProgress = false;
        await updateActionBadge();
      }
    }).finally(() => {
      momoxInflight.delete(ean);
    });
    momoxInflight.set(ean, pending);
  }
  return pending;
}

async function getQueueBatch(now = Date.now()) {
  const queueMap = await getPendingQueueMap();
  return Object.entries(queueMap)
    .filter(([, item]) => (item?.nextAttemptAt ?? 0) <= now)
    .sort((a, b) => (a[1].nextAttemptAt ?? 0) - (b[1].nextAttemptAt ?? 0))
    .slice(0, MOMOX_WORK_BATCH_SIZE)
    .map(([ean]) => ean);
}

async function popAlbumBatch(limit = 5) {
  const queueMap = await getPendingAlbumMap();
  const ids = Object.keys(queueMap).slice(0, limit);
  if (!ids.length) return [];
  for (const id of ids) {
    delete queueMap[id];
  }
  await savePendingAlbumMap(queueMap);
  return ids;
}

async function processPendingQueueTick() {
  if (queueTickRunning) return;
  queueTickRunning = true;
  try {
    const pause = await getMomoxPauseState();
    const albumIds = await popAlbumBatch(5);
    for (const albumId of albumIds) {
      await resolveEanForAlbum(albumId);
    }
    if (pause) return;

    const eans = await getQueueBatch();
    for (const ean of eans) {
      try {
        await fetchMomoxOfferData(ean);
      } catch (error) {
        if (error?.pausedUntil) {
          await markEanFetchFailure(ean, error, error.pausedUntil);
        } else if (!isMomoxThrottleStatus(error?.status)) {
          await markEanFetchFailure(ean, error);
        }
      }
    }
  } finally {
    queueTickRunning = false;
  }
}

async function fetchBdphileAlbumHtml(albumId) {
  const url = `${BDPHILE_ORIGIN}/bdtheque/album/${albumId}/`;
  const response = await fetchWithCookies(url, {
    headers: { Accept: "text/html,application/xhtml+xml" },
  });
  const html = await response.text();
  return { ok: response.ok, status: response.status, html };
}

async function resolveEanForAlbum(albumId) {
  const cached = await cache.readBdphileEan(albumId);
  if (cached !== undefined) {
    if (cached) {
      await enqueueEanForFetch(cached);
    }
    return { ean: cached, fromCache: true };
  }

  const { ok, status, html } = await fetchBdphileAlbumHtml(albumId);
  if (!ok) {
    return { error: `HTTP ${status}`, stage: "bdphile" };
  }

  const ean = parseEanFromHtml(html);
  await cache.writeBdphileEan(albumId, ean);
  if (ean) {
    await enqueueEanForFetch(ean);
  }

  const needsLogin =
    !ean &&
    !/déconnexion|logout/i.test(html) &&
    /connexion|connectez-vous|identifiant/i.test(html);

  return { ean, needsLogin, fromCache: false };
}

async function getAlbumMomoxPrice(albumId, options = {}) {
  if (options.forceRefresh && options.ean) {
    const key = `momox:${options.ean}`;
    await ext.storage.local.remove(key);
  }

  let pending = bdphileInflight.get(albumId);
  if (!pending) {
    pending = (async () => {
      const eanResult = await resolveEanForAlbum(albumId);
      if (eanResult.error) {
        return { ok: false, error: eanResult.error, stage: "bdphile" };
      }

      if (!eanResult.ean) {
        return {
          ok: true,
          state: "no-ean",
          needsLogin: eanResult.needsLogin,
        };
      }

      try {
        const momoxResult = await fetchMomoxOfferData(eanResult.ean);
        return {
          ok: true,
          state: "momox",
          ean: eanResult.ean,
          offer: momoxResult.offer,
          fromCache: momoxResult.fromCache,
          cachedAt: momoxResult.cachedAt,
          cacheAge: momoxResult.cacheAge,
        };
      } catch (error) {
        const status = error?.status;
        const paused = error?.paused === true;
        let message;
        if (paused && error.pausedUntil) {
          const mins = Math.ceil((error.pausedUntil - Date.now()) / 60000);
          message = `Momox en pause ~${mins} min (évitez de recharger la page)`;
        } else if (status === 429 || status === 403) {
          message = `limite Momox (${status}) — attendez avant de réessayer`;
        } else {
          message =
            error instanceof Error ? error.message : String(error);
        }
        return {
          ok: false,
          stage: "momox",
          ean: eanResult.ean,
          error: message,
          rateLimited: isMomoxThrottleStatus(status) || paused,
          paused,
          pausedUntil: error?.pausedUntil,
        };
      }
    })().finally(() => {
      bdphileInflight.delete(albumId);
    });
    bdphileInflight.set(albumId, pending);
  }
  return pending;
}

function startQueueWorker() {
  if (ext.alarms?.create) {
    ext.alarms.create(MOMOX_WORK_ALARM, { periodInMinutes: 1 });
  }
  void processPendingQueueTick();
  void updateActionBadge();
}

if (ext.alarms?.onAlarm) {
  ext.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name !== MOMOX_WORK_ALARM) return;
    void processPendingQueueTick();
  });
}

if (ext.runtime?.onStartup) {
  ext.runtime.onStartup.addListener(() => {
    startQueueWorker();
  });
}
if (ext.runtime?.onInstalled) {
  ext.runtime.onInstalled.addListener(() => {
    startQueueWorker();
  });
}
if (extAction?.onClicked) {
  extAction.onClicked.addListener(() => {
    if (ext.runtime?.openOptionsPage) {
      void ext.runtime.openOptionsPage();
    }
  });
}
startQueueWorker();

ext.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getAlbumMomoxPrice") {
    getAlbumMomoxPrice(message.albumId, {
      forceRefresh: message.forceRefresh,
      ean: message.ean,
    })
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          ok: false,
          stage: "unknown",
          error: err instanceof Error ? err.message : String(err),
        })
      );
    return true;
  }

  if (message?.type === "getMomoxPauseState") {
    getMomoxPauseState()
      .then((pause) => sendResponse({ ok: true, pause }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "clearMomoxCooldown") {
    clearMomoxCooldown()
      .then(async () => {
        await updateActionBadge();
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "getCacheStats") {
    Promise.all([cache.getStats(), getPendingQueueMap(), getPendingAlbumMap()])
      .then(([stats, queueMap, albumMap]) =>
        sendResponse({
          ok: true,
          stats: {
            ...stats,
            pendingEans: Object.keys(queueMap).length,
            pendingAlbums: Object.keys(albumMap).length,
          },
        })
      )
      .catch((err) =>
        sendResponse({ ok: false, error: String(err) })
      );
    return true;
  }

  if (message?.type === "clearCache") {
    let action;
    if (message.target === "momox") {
      action = cache.clearMomox();
    } else if (message.target === "bdphile") {
      action = cache.clearBdphile();
    } else {
      action = cache.clearAll().then((r) => r.momox + r.bdphile);
    }
    Promise.resolve(action)
      .then(async (removed) => {
        await updateActionBadge();
        sendResponse({ ok: true, removed });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "registerAlbumIds") {
    enqueueAlbumIds(message.albumIds)
      .then(() => {
        void processPendingQueueTick();
        sendResponse({ ok: true });
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
