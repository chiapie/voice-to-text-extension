const enBtn = document.getElementById("en");
const zhTwBtn = document.getElementById("zh-tw");
const enabledInput = document.getElementById("enabled");
const statusEl = document.getElementById("status");
const statusText = document.getElementById("status-text");

function renderLang(lang) {
  const isZh = (lang || "").toLowerCase().startsWith("zh");
  enBtn.classList.toggle("active", !isZh);
  zhTwBtn.classList.toggle("active", isZh);
}

function renderEnabled(on) {
  enabledInput.checked = on;
  statusEl.classList.toggle("off", !on);
  statusText.textContent = on ? "Active · listening on hold" : "Disabled";
}

chrome.storage.local.get(["lang", "enabled"]).then((v) => {
  renderLang(v.lang || navigator.language || "en-US");
  renderEnabled(v.enabled !== false);
});

enBtn.addEventListener("click", () => {
  chrome.storage.local.set({ lang: "en-US" });
  renderLang("en-US");
});
zhTwBtn.addEventListener("click", () => {
  chrome.storage.local.set({ lang: "zh-TW" });
  renderLang("zh-TW");
});
enabledInput.addEventListener("change", () => {
  chrome.storage.local.set({ enabled: enabledInput.checked });
  renderEnabled(enabledInput.checked);
});
