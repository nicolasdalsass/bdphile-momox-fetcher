/**
 * When you visit momox.fr, capture the API token embedded in the page for api.momox.de.
 */
const ext = globalThis.browser ?? globalThis.chrome;

function findTokenInText(text) {
  const labeled =
    text.match(/X-API-TOKEN['"]\s*[:=]\s*['"]([a-f0-9]{40})['"]/i) ||
    text.match(/apiToken['"]\s*[:=]\s*['"]([a-f0-9]{40})['"]/i);
  if (labeled) return labeled[1];

  const scripts = [...document.scripts]
    .map((s) => s.textContent || "")
    .join("\n");
  const fromScripts =
    scripts.match(/X-API-TOKEN['"]\s*[:=]\s*['"]([a-f0-9]{40})['"]/i) ||
    scripts.match(/apiToken['"]\s*[:=]\s*['"]([a-f0-9]{40})['"]/i);
  return fromScripts ? fromScripts[1] : null;
}

function saveToken(token) {
  ext.runtime.sendMessage({ type: "setMomoxApiToken", token }).catch(() => {});
}

const token = findTokenInText(document.documentElement.innerHTML);
if (token) {
  saveToken(token);
}
