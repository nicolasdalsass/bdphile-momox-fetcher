/**
 * Persistent cache in browser.storage.local (survives browser restarts).
 * Loaded before background.js via manifest.
 */
const BdphileMomoxCache = (() => {
  const ext = globalThis.browser ?? globalThis.chrome;

  const DEFAULT_SETTINGS = {
    momoxTtlDays: 14,
    bdphileEanTtlDays: 90,
  };

  const PREFIX_MOMOX = "momox:";
  const PREFIX_BDPHILE = "bdphile:album:";

  function momoxKey(ean) {
    return `${PREFIX_MOMOX}${ean}`;
  }

  function bdphileKey(albumId) {
    return `${PREFIX_BDPHILE}${albumId}`;
  }

  function ttlMs(days) {
    return days * 24 * 60 * 60 * 1000;
  }

  async function getSettings() {
    const stored = await ext.storage.local.get("cacheSettings");
    return { ...DEFAULT_SETTINGS, ...stored.cacheSettings };
  }

  async function setSettings(partial) {
    const current = await getSettings();
    await ext.storage.local.set({
      cacheSettings: { ...current, ...partial },
    });
  }

  function isFresh(fetchedAt, ttlDays) {
    return Date.now() - fetchedAt < ttlMs(ttlDays);
  }

  function formatAge(fetchedAt) {
    const hours = Math.floor((Date.now() - fetchedAt) / (60 * 60 * 1000));
    if (hours < 1) return "moins d’1 h";
    if (hours < 24) return `il y a ${hours} h`;
    const days = Math.floor(hours / 24);
    return days === 1 ? "il y a 1 jour" : `il y a ${days} jours`;
  }

  async function readMomox(ean) {
    const settings = await getSettings();
    const key = momoxKey(ean);
    const stored = await ext.storage.local.get(key);
    const entry = stored[key];
    if (!entry) return null;
    if (!isFresh(entry.fetchedAt, settings.momoxTtlDays)) {
      await ext.storage.local.remove(key);
      return null;
    }
    return {
      data: entry.data,
      fetchedAt: entry.fetchedAt,
      ageLabel: formatAge(entry.fetchedAt),
    };
  }

  async function writeMomox(ean, data) {
    await ext.storage.local.set({
      [momoxKey(ean)]: { fetchedAt: Date.now(), data },
    });
  }

  /**
   * @returns {string|null|undefined} undefined = miss, null = known absent EAN
   */
  async function readBdphileEan(albumId) {
    const settings = await getSettings();
    const key = bdphileKey(albumId);
    const stored = await ext.storage.local.get(key);
    const entry = stored[key];
    if (!entry) return undefined;
    if (!isFresh(entry.fetchedAt, settings.bdphileEanTtlDays)) {
      await ext.storage.local.remove(key);
      return undefined;
    }
    return entry.ean ?? null;
  }

  async function writeBdphileEan(albumId, ean) {
    await ext.storage.local.set({
      [bdphileKey(albumId)]: { fetchedAt: Date.now(), ean },
    });
  }

  async function getStats() {
    const all = await ext.storage.local.get(null);
    let momoxOffers = 0;
    let bdphileEans = 0;
    let bytesApprox = 0;

    for (const [key, value] of Object.entries(all)) {
      bytesApprox += key.length + JSON.stringify(value).length;
      if (key.startsWith(PREFIX_MOMOX)) momoxOffers++;
      if (key.startsWith(PREFIX_BDPHILE)) bdphileEans++;
    }

    const settings = await getSettings();
    return {
      momoxOffers,
      bdphileEans,
      bytesApprox,
      settings,
    };
  }

  async function clear(prefix) {
    const all = await ext.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
    if (keys.length) {
      await ext.storage.local.remove(keys);
    }
    return keys.length;
  }

  async function clearAll() {
    const momox = await clear(PREFIX_MOMOX);
    const bdphile = await clear(PREFIX_BDPHILE);
    return { momox, bdphile };
  }

  return {
    getSettings,
    setSettings,
    readMomox,
    writeMomox,
    readBdphileEan,
    writeBdphileEan,
    getStats,
    clearAll,
    clearMomox: () => clear(PREFIX_MOMOX),
    clearBdphile: () => clear(PREFIX_BDPHILE),
    formatAge,
  };
})();

globalThis.BdphileMomoxCache = BdphileMomoxCache;
