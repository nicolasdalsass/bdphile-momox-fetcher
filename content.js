const ext = globalThis.browser ?? globalThis.chrome;

/** Only one Bdphile album page fetch at a time (Momox is queued separately in background). */
const BDPHILE_CONCURRENCY = 1;

function isAlbumListPage() {
  return /^\/bdtheque\/album\/?$/.test(location.pathname);
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    ext.runtime.sendMessage(message, (response) => {
      const err = ext.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(response);
    });
  });
}

function formatPrice(price, currency) {
  const value = Number.parseFloat(price);
  if (Number.isNaN(value)) return null;
  const formatted = value.toFixed(2).replace(".", ",");
  if (currency?.toLowerCase() === "eur") return `${formatted} €`;
  return `${formatted} ${currency || ""}`.trim();
}

function ensureChip(anchor) {
  if (anchor.querySelector(".momox-chip")) {
    return anchor.querySelector(".momox-chip");
  }

  anchor.classList.add("momox-cover-wrap");
  const chip = document.createElement("span");
  chip.className = "momox-chip momox-chip--loading";
  chip.textContent = "…";
  chip.setAttribute("aria-label", "Prix Momox en cours de chargement");
  anchor.appendChild(chip);
  return chip;
}

function setChipState(chip, state, label, title) {
  chip.className = `momox-chip momox-chip--${state}`;
  chip.textContent = label;
  chip.title = title ?? "";
  chip.setAttribute("aria-label", title ? `Momox : ${title}` : `Momox : ${label}`);
}

async function loadChipForCover(anchor) {
  if (anchor.dataset.momoxLoaded === "1" || anchor.dataset.momoxLoading === "1") {
    return;
  }
  anchor.dataset.momoxLoading = "1";

  const match = anchor.href.match(/\/bdtheque\/album\/(\d+)\/?$/);
  if (!match) {
    anchor.dataset.momoxLoading = "";
    return;
  }

  const albumId = match[1];
  const chip = ensureChip(anchor);
  let rateLimited = false;

  try {
    const result = await sendMessage({ type: "getAlbumMomoxPrice", albumId });

    if (!result) {
      setChipState(chip, "error", "?", "Extension : pas de réponse");
      return;
    }

    if (!result.ok) {
      if (result.rateLimited) {
        rateLimited = true;
        setChipState(chip, "rate-limit", "⏳", result.error);
        return;
      }
      const hint =
        result.stage === "bdphile"
          ? "Bdphile : reconnectez-vous sur le site"
          : result.stage === "momox"
            ? result.error ?? "erreur Momox"
            : result.error ?? "erreur";
      setChipState(chip, "error", "?", hint);
      return;
    }

    if (result.state === "no-ean") {
      const hint = result.needsLogin
        ? "Connectez-vous à Bdphile"
        : "EAN absent sur la fiche";
      setChipState(chip, "no-ean", "—", hint);
      return;
    }

    const cacheHint = result.fromCache && result.cacheAge
      ? `Cache Momox (${result.cacheAge})`
      : "";

    const offer = result.offer;
    if (offer?.status === "offer" && offer.price != null) {
      const label =
        formatPrice(offer.price, offer.currency) ?? `${offer.price} €`;
      setChipState(chip, "offer", label, cacheHint || undefined);
      return;
    }

    setChipState(chip, "no-offer", "—", cacheHint || "Pas d'offre de rachat");
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const hint = msg.includes("Receiving end does not exist")
      ? "Rechargez l’extension (about:debugging)"
      : msg;
    setChipState(chip, "error", "?", hint);
  } finally {
    if (!rateLimited) {
      anchor.dataset.momoxLoaded = "1";
    }
    anchor.dataset.momoxLoading = "";
  }
}

async function runPool(items, worker, limit) {
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const i = index++;
      await worker(items[i]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    runWorker
  );
  await Promise.all(workers);
}

function observeCovers(anchors) {
  if (!("IntersectionObserver" in window)) {
    void runPool(anchors, loadChipForCover, BDPHILE_CONCURRENCY);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const anchor = entry.target;
        observer.unobserve(anchor);
        void loadChipForCover(anchor);
      }
    },
    { root: null, rootMargin: "120px", threshold: 0.01 }
  );

  for (const anchor of anchors) {
    observer.observe(anchor);
  }
}

function processAlbumList() {
  const anchors = [
    ...document.querySelectorAll('a.list-cover[href*="/bdtheque/album/"]'),
  ].filter((a) => !a.dataset.momoxDone);

  for (const anchor of anchors) {
    anchor.dataset.momoxDone = "1";
    ensureChip(anchor);
  }

  observeCovers(anchors);
}

if (isAlbumListPage()) {
  processAlbumList();
}
