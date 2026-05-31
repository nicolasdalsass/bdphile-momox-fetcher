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

function extractApiTokenFromHtml(html) {
  const patterns = [
    /X-API-TOKEN['"]\s*[:=]\s*['"]([a-f0-9]{40})['"]/i,
    /apiToken['"]\s*[:=]\s*['"]([a-f0-9]{40})['"]/i,
    /api[_-]?token['"]\s*[:=]\s*['"]([a-f0-9]{40})['"]/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function getMomoxApiToken() {
  const stored = await ext.storage.local.get("momoxApiToken");
  return stored.momoxApiToken || DEFAULT_MOMOX_API_TOKEN;
}

async function refreshMomoxApiTokenFromSite() {
  try {
    const response = await fetch("https://www.momox.fr/", {
      credentials: "include",
      headers: { ...FETCH_HEADERS, Accept: "text/html" },
    });
    if (!response.ok) return;
    const token = extractApiTokenFromHtml(await response.text());
    if (token) {
      await ext.storage.local.set({ momoxApiToken: token });
    }
  } catch {
    // ignore
  }
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

async function cookieHeaderFor(url) {
  const cookies = await ext.cookies.getAll({ url });
  if (!cookies.length) return "";
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function fetchWithCookies(url, init = {}) {
  const cookie = await cookieHeaderFor(url);
  const headers = { ...FETCH_HEADERS, ...init.headers };
  if (cookie) {
    headers.Cookie = cookie;
  }

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
      Referer: "https://www.momox.fr/",
      Origin: "https://www.momox.fr",
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

async function fetchMomoxOfferData(ean, allowTokenRefresh = true) {
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
      let token = await getMomoxApiToken();
      try {
        const data = await requestMomoxOffer(ean, token);
        await cache.writeMomox(ean, data);
        return { offer: data, fromCache: false };
      } catch (firstError) {
        if (isMomoxThrottleStatus(firstError?.status)) {
          const cooldown =
            firstError.retryAfterMs ?? MOMOX_COOLDOWN_DEFAULT_MS;
          await setMomoxCooldown(cooldown);
          throw firstError;
        }
        if (!allowTokenRefresh) {
          throw firstError;
        }
        await refreshMomoxApiTokenFromSite();
        token = await getMomoxApiToken();
        const data = await requestMomoxOffer(ean, token);
        await cache.writeMomox(ean, data);
        return { offer: data, fromCache: false };
      }
    }).finally(() => {
      momoxInflight.delete(ean);
    });
    momoxInflight.set(ean, pending);
  }
  return pending;
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
    return { ean: cached, fromCache: true };
  }

  const { ok, status, html } = await fetchBdphileAlbumHtml(albumId);
  if (!ok) {
    return { error: `HTTP ${status}`, stage: "bdphile" };
  }

  const ean = parseEanFromHtml(html);
  await cache.writeBdphileEan(albumId, ean);

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

  if (message?.type === "setMomoxApiToken" && message.token) {
    ext.storage.local
      .set({ momoxApiToken: message.token })
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({
          ok: false,
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
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "getCacheStats") {
    cache
      .getStats()
      .then((stats) => sendResponse({ ok: true, stats }))
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
      .then((removed) => sendResponse({ ok: true, removed }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
