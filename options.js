const ext = globalThis.browser ?? globalThis.chrome;

const statsEl = document.getElementById("stats");
const pauseStateEl = document.getElementById("pauseState");
const messageEl = document.getElementById("message");
const momoxTtlEl = document.getElementById("momoxTtl");
const bdphileTtlEl = document.getElementById("bdphileTtl");

function showMessage(text, ok = false) {
  messageEl.textContent = text;
  messageEl.className = ok ? "ok" : "";
}

async function refreshStats() {
  const [statsRes, pauseRes] = await Promise.all([
    ext.runtime.sendMessage({ type: "getCacheStats" }),
    ext.runtime.sendMessage({ type: "getMomoxPauseState" }),
  ]);

  if (!statsRes?.ok) {
    statsEl.textContent = "Impossible de lire le cache.";
    return;
  }
  const { momoxOffers, bdphileEans, pendingEans, pendingAlbums, bytesApprox, settings } = statsRes.stats;
  momoxTtlEl.value = settings.momoxTtlDays;
  bdphileTtlEl.value = settings.bdphileEanTtlDays;
  const kb = Math.round(bytesApprox / 1024);
  statsEl.textContent = `${momoxOffers} prix Momox · ${bdphileEans} albums Bdphile · ${pendingAlbums ?? 0} albums en attente · ${pendingEans ?? 0} EAN en attente · ~${kb} Ko`;

  if (pauseRes?.ok && pauseRes.pause) {
    const mins = Math.ceil(pauseRes.pause.remainingMs / 60000);
    pauseStateEl.textContent = `⏸ Momox en pause encore ~${mins} min (seul le cache s’affiche).`;
    pauseStateEl.style.color = "#9b1c1c";
  } else {
    pauseStateEl.textContent = "Momox : appels réseau autorisés.";
    pauseStateEl.style.color = "#1a7f37";
  }
}

document.getElementById("saveSettings").addEventListener("click", async () => {
  await ext.storage.local.set({
    cacheSettings: {
      momoxTtlDays: Number(momoxTtlEl.value) || 14,
      bdphileEanTtlDays: Number(bdphileTtlEl.value) || 90,
    },
  });
  showMessage("Réglages enregistrés.", true);
  await refreshStats();
});

async function clear(target) {
  const response = await ext.runtime.sendMessage({ type: "clearCache", target });
  if (response?.ok) {
    showMessage(`${response.removed} entrée(s) supprimée(s).`, true);
    await refreshStats();
  } else {
    showMessage("Erreur lors du vidage.");
  }
}

document.getElementById("clearMomox").addEventListener("click", () => clear("momox"));
document.getElementById("clearBdphile").addEventListener("click", () => clear("bdphile"));
document.getElementById("clearAll").addEventListener("click", () => clear("all"));

document.getElementById("clearCooldown").addEventListener("click", async () => {
  await ext.runtime.sendMessage({ type: "clearMomoxCooldown" });
  showMessage("Pause Momox levée. Réessayez doucement (une page à la fois).", true);
  await refreshStats();
});

refreshStats();
