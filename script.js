const CASES_SQL = `
CREATE TABLE cases (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  price INTEGER NOT NULL,
  category TEXT,
  img TEXT,
  chance JSONB NOT NULL DEFAULT '{}' 
);

CREATE TABLE case_items (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  img TEXT,
  rarity TEXT
);

INSERT INTO cases (name, price, category, img, chance) VALUES
  ('Starter Case', 99, 'Starter', '🎁', '{"Серый":70,"Зеленый":20,"Синий":8,"Фиолетовый":2,"Золотой":0,"Красный":0}'),
  ('Street Case', 299, 'Street', '🚗', '{"Серый":60,"Зеленый":25,"Синий":10,"Фиолетовый":5,"Золотой":0,"Красный":0}'),
  ('Elite Case', 799, 'Elite', '💎', '{"Серый":50,"Зеленый":30,"Синий":15,"Фиолетовый":5,"Золотой":0,"Красный":0}'),
  ('Legend Case', 1499, 'Legend', '👑', '{"Серый":40,"Зеленый":30,"Синий":20,"Фиолетовый":10,"Золотой":0,"Красный":0}');

INSERT INTO case_items (case_id, name, price, img, rarity) VALUES
  (1, 'Glock Paint', 450, 'bc.png', 'Серый'),
  (1, 'Starter Bike', 1200, 'skuter.png', 'Серый'),
  (1, 'Cash Bonus', 2500, 'money.png', 'Серый'),
  (2, 'Niva Urban', 3800, 'niva.png', 'Зеленый'),
  (2, 'Street Outfit', 5100, 'streetglass.png', 'Зеленый'),
  (2, 'Garage Cash', 7200, 'money.png', 'Зеленый'),
  (3, 'BMW M5', 18400, 'm5e60.png', 'Синий'),
  (3, 'VIP Skin', 24600, 'zolo.png', 'Синий'),
  (3, 'Diamond Stack', 31000, 'zolo.png', 'Синий'),
  (4, 'Lamborghini', 79000, 'aventador.png', 'Фиолетовый'),
  (4, 'Gold Chain', 42000, 'maybach.png', 'Фиолетовый'),
  (4, 'President House', 120000, 'senat.png', 'Фиолетовый');
`;

const STORAGE_KEYS = {
  session: "br_drop_session",
  cases: "br_drop_cases",
  items: "br_drop_items",
  rarityWeights: "br_drop_rarity_weights"
};

function parseSqlInsertRows(sql) {
  const rows = [];
  const statementRegex = /INSERT\s+INTO\s+([^\s(]+)\s*\(([^)]+)\)\s*VALUES\s*((?:\([^;]+\))(?:\s*,\s*\([^;]+\))*)\s*;/gim;
  let statementMatch;

  while ((statementMatch = statementRegex.exec(sql)) !== null) {
    const tableName = statementMatch[1].trim();
    const columns = statementMatch[2].split(",").map((col) => col.trim());
    const valuesBlock = statementMatch[3];
    const rowRegex = /\(([^)]+)\)/g;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(valuesBlock)) !== null) {
      const rawRow = rowMatch[1];
      const values = [];
      let buffer = "";
      let inQuote = false;

      for (let i = 0; i < rawRow.length; i += 1) {
        const char = rawRow[i];

        if (char === "'") {
          if (inQuote && rawRow[i + 1] === "'") {
            buffer += "'";
            i += 1;
            continue;
          }
          inQuote = !inQuote;
          continue;
        }

        if (char === "," && !inQuote) {
          values.push(buffer.trim());
          buffer = "";
          continue;
        }

        buffer += char;
      }

      if (buffer.length) {
        values.push(buffer.trim());
      }

      const row = {};
      columns.forEach((column, index) => {
        let value = values[index] ?? null;
        if (value === null || value.toUpperCase() === "NULL") {
          row[column] = null;
        } else if (/^'.*'$/.test(value)) {
          row[column] = value.slice(1, -1).replace(/''/g, "'");
        } else if (/^\d+$/.test(value)) {
          row[column] = Number(value);
        } else {
          row[column] = value;
        }
      });

      rows.push({ tableName, row });
    }
  }

  return rows;
}

function normalizeItemImagePath(src) {
  if (!src || typeof src !== 'string') {
    return '';
  }

  const trimmed = src.trim();
  if (!trimmed) {
    return '';
  }

  if (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('/')
  ) {
    return trimmed;
  }

  return `./assets/items/${trimmed}`;
}

function sortRewardsByPriceDesc(rewards) {
  if (!Array.isArray(rewards)) {
    return [];
  }

  return [...rewards].sort((a, b) => Number(b.price || 0) - Number(a.price || 0));
}

function normalizeSavedCases(casesArray) {
  if (!Array.isArray(casesArray)) {
    return [];
  }

  return casesArray.map((caseItem) => ({
    ...caseItem,
    img: normalizeItemImagePath(caseItem.img || ''),
    rewards: sortRewardsByPriceDesc(
      Array.isArray(caseItem.rewards)
        ? caseItem.rewards.map((reward) => ({
            ...reward,
            img: normalizeItemImagePath(reward.img || '')
          }))
        : []
    )
  }));
}

function normalizeChanceWeights(chanceValue) {
  const defaults = getDefaultRarityWeights();
  if (!chanceValue) {
    return defaults;
  }

  let parsed = chanceValue;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return defaults;
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return defaults;
  }

  const normalized = {};
  const mapping = {
    common: 'Серый',
    rare: 'Зеленый',
    epic: 'Фиолетовый',
    legendary: 'Золотой',
    gray: 'Серый',
    green: 'Зеленый',
    blue: 'Синий',
    purple: 'Фиолетовый',
    gold: 'Золотой',
    red: 'Красный',
    серый: 'Серый',
    зеленый: 'Зеленый',
    синий: 'Синий',
    фиолетовый: 'Фиолетовый',
    золотой: 'Золотой',
    красный: 'Красный'
  };

  Object.entries(parsed).forEach(([key, value]) => {
    const normalizedKey = mapping[String(key).trim().toLowerCase()] || String(key).trim();
    if (normalizedKey) {
      normalized[normalizedKey] = Number(value || 0);
    }
  });

  return { ...defaults, ...normalized };
}

function parseCaseChance(chanceValue) {
  return normalizeChanceWeights(chanceValue);
}

function buildCasesFromSql() {
  const rows = parseSqlInsertRows(CASES_SQL);
  const caseRows = rows
    .filter((entry) => entry.tableName.toLowerCase() === "cases")
    .map((entry, index) => ({ id: index + 1, ...entry.row }));

  const itemRows = rows.filter((entry) => entry.tableName.toLowerCase() === "case_items").map((entry) => entry.row);

  return caseRows.map((caseRow) => ({
    id: caseRow.id,
    name: caseRow.name,
    price: Number(caseRow.price),
    category: caseRow.category || '',
    img: caseRow.img || '',
    chance: parseCaseChance(caseRow.chance),
    rewards: sortRewardsByPriceDesc(
      itemRows
        .filter((item) => Number(item.case_id) === caseRow.id)
        .map((item) => ({
          name: item.name || '',
          price: Number(item.price),
          img: normalizeItemImagePath(item.img || ''),
          rarity: item.rarity || 'Серый'
        }))
    )
  }));
}

function loadStoredCases() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.cases);
    if (!stored) {
      return null;
    }
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? normalizeSavedCases(parsed) : null;
  } catch {
    return null;
  }
}

function saveStoredCases(cases) {
  try {
    localStorage.setItem(STORAGE_KEYS.cases, JSON.stringify(cases));
  } catch (e) {
    console.error("Не удалось сохранить кейсы:", e);
  }
}

function loadStoredItems() {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.items);
    if (!stored) {
      return [];
    }
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveStoredItems(items) {
  try {
    localStorage.setItem(STORAGE_KEYS.items, JSON.stringify(items));
  } catch (e) {
    console.error("Не удалось сохранить предметы:", e);
  }
}

function getDefaultRarityWeights() {
  return {
    Серый: 70,
    Зеленый: 20,
    Синий: 8,
    Фиолетовый: 2,
    Золотой: 0,
    Красный: 0
  };
}

function loadRarityWeights() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.rarityWeights);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') {
      return getDefaultRarityWeights();
    }
    const normalizedWeights = {};
    Object.entries(parsed).forEach(([key, value]) => {
      const normalizedKey = String(key || '').trim();
      if (normalizedKey) {
        normalizedWeights[normalizedKey] = Number(value || 0);
      }
    });
    return { ...getDefaultRarityWeights(), ...normalizedWeights };
  } catch {
    return getDefaultRarityWeights();
  }
}

function selectRewardByRarityWeights(rewards, chanceWeights) {
  if (!Array.isArray(rewards) || rewards.length === 0) {
    return null;
  }

  const weights = {
    ...getDefaultRarityWeights(),
    ...(typeof chanceWeights === 'object' && chanceWeights !== null ? chanceWeights : {})
  };

  const weightedList = rewards.map((reward) => {
    const rarityKey = reward.rarity || 'Серый';
    const rarityWeight = Number(weights[rarityKey] ?? weights[reward.rarity] ?? 0);
    const weight = Math.max(0, rarityWeight);
    return {
      reward,
      weight: weight > 0 ? weight : 1
    };
  });

  const totalWeight = weightedList.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    return rewards[Math.floor(Math.random() * rewards.length)];
  }

  let threshold = Math.random() * totalWeight;
  for (const item of weightedList) {
    if (threshold < item.weight) {
      return item.reward;
    }
    threshold -= item.weight;
  }

  return weightedList[weightedList.length - 1].reward;
}

let cases = loadStoredCases();
let itemsCatalog = loadStoredItems();
if (!cases) {
  cases = buildCasesFromSql();
  saveStoredCases(cases);
}

const SUPABASE_URL = "https://rniavxontiwnxkivzirw.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJuaWF2eG9udGl3bnhraXZ6aXJ3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3ODc4NDksImV4cCI6MjA5OTM2Mzg0OX0.YRZUnP5B7vIc_jZnQPw4_Rs4rWv14CJTk2c6Iwj4wI4";
const supabaseClient =
  window.supabase &&
  SUPABASE_URL !== "YOUR_SUPABASE_URL" &&
  SUPABASE_ANON_KEY !== "YOUR_SUPABASE_ANON_KEY"
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

async function refreshDataFromSupabase() {
  if (!supabaseClient) {
    return { ok: false, message: "Supabase клиент недоступен." };
  }

  const { data: caseRows, error: caseError } = await supabaseClient
    .from("cases")
    .select("id, name, price, category, img, chance")
    .order("id", { ascending: true });

  const { data: itemRows, error: itemError } = await supabaseClient
    .from("case_items")
    .select("case_id, name, price, img, rarity")
    .order("case_id", { ascending: true });

  const { data: catalogRows, error: catalogError } = await supabaseClient
    .from("items")
    .select("name, price, rarity, type, image")
    .order("name", { ascending: true });

  if (caseError || itemError || catalogError) {
    return {
      ok: false,
      message: [caseError?.message, itemError?.message, catalogError?.message].filter(Boolean).join(" | ")
    };
  }

  const itemsByCase = new Map();
  (Array.isArray(itemRows) ? itemRows : []).forEach((item) => {
    if (!itemsByCase.has(item.case_id)) {
      itemsByCase.set(item.case_id, []);
    }
    itemsByCase.get(item.case_id).push({
      name: item.name || "",
      price: Number(item.price || 0),
      img: normalizeItemImagePath(item.img || ""),
      rarity: item.rarity || "Серый"
    });
  });

  const nextCases = (Array.isArray(caseRows) ? caseRows : []).map((item) => ({
    id: item.id,
    name: item.name || "",
    price: Number(item.price || 0),
    category: item.category || "",
    img: item.img || "",
    chance: parseCaseChance(item.chance),
    rewards: sortRewardsByPriceDesc(Array.isArray(itemsByCase.get(item.id)) ? itemsByCase.get(item.id) : [])
  }));

  const nextItems = (Array.isArray(catalogRows) ? catalogRows : []).map((item) => ({
    name: item.name || "",
    price: Number(item.price || 0),
    rarity: item.rarity || "Серый",
    type: item.type || "Cosmetic",
    image: item.image || ""
  }));

  const newsResult = await loadNewsFromSupabase();
  const nextNews = newsResult.ok && Array.isArray(newsResult.data) ? newsResult.data : [];

  cases = nextCases.length > 0 ? nextCases : cases;
  itemsCatalog = nextItems.length > 0 ? nextItems : itemsCatalog;
  newsItems = nextNews.length > 0 ? nextNews : newsItems;
  saveStoredCases(cases);
  saveStoredItems(itemsCatalog);
  return {
    ok: true,
    message: [
      "Данные обновлены из Supabase.",
      newsResult.ok ? "Новости загружены из Supabase." : `Новости: ${newsResult.message}`
    ].filter(Boolean).join(" ")
  };
}

async function loadNewsFromSupabase() {
  if (!supabaseClient) {
    return { ok: false, message: "Supabase клиент недоступен." };
  }

  const { data, error } = await supabaseClient
    .from("news")
    .select("title, text, image, pinned")
    .order("id", { ascending: true });

  if (error) {
    return { ok: false, message: error.message };
  }

  const news = Array.isArray(data)
    ? data.map((item) => ({
        title: item.title || "",
        text: item.text || "",
        image: item.image || "",
        pinned: item.pinned === true || item.pinned === "true"
      }))
    : [];

  return { ok: true, data: news };
}

const authModal = document.getElementById("auth-modal");
const authForm = document.getElementById("auth-form");
const authNameInput = document.getElementById("auth-name");
const authLastnameInput = document.getElementById("auth-lastname");
const authPasswordInput = document.getElementById("auth-password");
const authMessage = document.getElementById("auth-message");
const authSubmit = document.getElementById("auth-submit");
const authServerRow = document.getElementById("auth-server-row");
const serverTrigger = document.getElementById("server-trigger");
const serverModal = document.getElementById("server-modal");
const serverModalClose = document.getElementById("server-modal-close");
const serverSelected = document.getElementById("server-selected");
const serverOptions = Array.from(document.querySelectorAll(".server-option"));
let selectedServer = "";
const loader = document.querySelector(".loading-screen");
const appShell = document.querySelector(".app-shell");
const loadingLogo = document.querySelector(".loading-logo");
const caseModal = document.getElementById("case-modal");
const caseModalImage = document.getElementById("case-modal-image");
const caseModalTitle = document.getElementById("case-modal-title");
const caseModalPrice = document.getElementById("case-modal-price");
const caseModalItems = document.getElementById("case-modal-items");
const caseModalCard = document.querySelector('.case-modal__card');
const caseOpenModal = document.getElementById("case-open-modal");
const caseOpenTitle = document.getElementById("case-open-title");
const caseOpenTapes = document.getElementById("case-open-tapes");
const caseOpenResult = document.getElementById("case-open-result");
const caseOpenResultEmoji = document.getElementById("case-open-result-emoji");
const caseOpenResultName = document.getElementById("case-open-result-name");
const caseOpenResultValue = document.getElementById("case-open-result-value");
const caseOpenContinueBtn = document.getElementById("case-open-continue-btn");
const caseOpenCloseBtns = Array.from(document.querySelectorAll("[data-close-case-open]"));
const caseCountButtons = Array.from(document.querySelectorAll(".case-modal__count"));
const openCaseFastBtn = document.getElementById("open-case-fast-btn");
const newsViewport = document.getElementById("news-viewport");
const newsPrevBtn = document.getElementById("news-prev");
const newsNextBtn = document.getElementById("news-next");
let selectedCaseCount = 1;

if (newsPrevBtn && newsNextBtn) {
  newsPrevBtn.addEventListener("click", () => {
    showNews(currentNewsIndex - 1);
    startNewsAutoRotate();
  });

  newsNextBtn.addEventListener("click", () => {
    showNews(currentNewsIndex + 1);
    startNewsAutoRotate();
  });
}

if (loader && loadingLogo) {
  window.addEventListener("load", () => {
    const loadTimeline = gsap.timeline({
      onComplete: () => {
        gsap.to(loader, {
          opacity: 0,
          duration: 0.45,
          ease: "power2.out",
          onComplete: () => {
            loader.classList.add("is-hidden");
          }
        });

        if (appShell) {
          appShell.classList.add("visible");
        }
      }
    });

    loadTimeline.from(loadingLogo, {
      opacity: 0,
      scale: 0.85,
      duration: 1.1,
      ease: "power2.out"
    }, 0);

    loadTimeline.from(
      loadingLogo,
      {
        filter: "blur(0.15em)",
        duration: 1.1,
        ease: "power2.inOut"
      },
      0
    );
  });
}

const authTabs = Array.from(document.querySelectorAll(".auth-tab"));
const gameArea = document.getElementById("game-area");
const casesDock = document.getElementById("cases-dock");
const logoutBtn = document.getElementById("logout-btn");
const profileChip = document.querySelector(".profile-chip");
const profileAvatar = document.getElementById("profile-avatar");
const profileName = document.getElementById("profile-name");
const profileBalance = document.getElementById("profile-balance");
const navProfileButton = document.getElementById("nav-profile");
const statBalance = document.getElementById("stat-balance");
const statOpened = document.getElementById("stat-opened");

const casesList = document.getElementById("cases-list");
const activeCaseName = document.getElementById("active-case-name");
const activeCasePrice = document.getElementById("active-case-price");
const caseIcon = document.getElementById("case-icon");
const caseRarity = document.getElementById("case-rarity");
const caseDifficulty = document.getElementById("case-difficulty");
const caseDescription = document.getElementById("case-description");
const casePreview = document.getElementById("case-preview");
const openCaseBtn = document.getElementById("open-case-btn");
const resultModal = document.getElementById("result-modal");
const resultPrevBtn = document.getElementById("result-prev-btn");
const resultNextBtn = document.getElementById("result-next-btn");
const resultNavWrapper = document.querySelector(".result-nav-wrapper");
const resultNavPanel = document.getElementById("result-nav-panel");
const resultCounter = document.getElementById("result-counter");
const rewardEmoji = document.getElementById("reward-emoji");
const rewardName = document.getElementById("reward-name");
const rewardValue = document.getElementById("reward-value");
const closeModalBtn = document.getElementById("close-modal-btn");
const resultSellBtn = document.getElementById("result-sell-btn");

let newsItems = [
  {
    title: "Обновление коллекции",
    text: "Новые редкие предметы уже доступны в кейсах. Проверьте обновлённый ассортимент и получите шанс на легендарный дроп.",
    image: "./assets/items/ak47.png",
    pinned: true
  },
  {
    title: "Скидка на премиум кейсы",
    text: "В течение недели скидка до 25% на эксклюзивные кейсы с повышенными шансами на редкие предметы.",
    image: "./assets/items/gtr.png",
    pinned: false
  },
  {
    title: "Новый сезон предметов",
    text: "В коллекцию добавлены свежие скины и редкости. Открывайте кейсы чаще и собирайте наборы.",
    image: "./assets/items/auto_case.png",
    pinned: true
  }
];

let authMode = "login";
let currentNewsIndex = 0;
let newsAutoRotateTimer = null;
let activeCaseIndex = 0;
let openedCount = 0;
let currentUser = loadSession();
let resultRewardIndex = null;
let lastOpenedCaseRewardIndex = null;
let resultRewards = [];
let resultInventoryOffset = null;
let selectedResultIndex = 0;

function loadSession() {
  try {
    const session = localStorage.getItem(STORAGE_KEYS.session);
    return session ? JSON.parse(session) : null;
  } catch {
    return null;
  }
}

function saveSession(user) {
  if (user) {
    localStorage.setItem(STORAGE_KEYS.session, JSON.stringify(user));
  } else {
    localStorage.removeItem(STORAGE_KEYS.session);
  }
}

function getInitials(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("")
    .slice(0, 2) || "BR";
}

function setMessage(text, isError = false) {
  authMessage.textContent = text;
  authMessage.style.color = isError ? "#ff8f8f" : "var(--muted)";
}

function setAuthMode(mode) {
  authMode = mode;
  authTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.mode === mode);
  });
  authSubmit.textContent = mode === "register" ? "Создать" : "Войти";
  authPasswordInput.autocomplete = mode === "register" ? "new-password" : "current-password";
  authServerRow.style.display = mode === "register" ? "grid" : "none";
  serverModal.setAttribute("hidden", "true");
  serverTrigger.setAttribute("aria-expanded", "false");
}

function updateProfileUI(user) {
  if (profileName) {
    profileName.textContent = user ? user.name : "Войти";
  }
  if (profileBalance) {
    profileBalance.textContent = `Баланс: ${Number(user?.balance || 0).toLocaleString("ru-RU")}₽`;
  }

  if (profileAvatar) {
    profileAvatar.textContent = user?.avatar_url ? "" : getInitials(user?.name || "BR");
    try {
      profileAvatar.style.backgroundImage = user?.avatar_url ? `url(${user.avatar_url})` : "";
      profileAvatar.style.backgroundSize = user?.avatar_url ? "cover" : "initial";
      profileAvatar.style.backgroundPosition = "center";
      profileAvatar.style.backgroundRepeat = "no-repeat";
      profileAvatar.style.color = user?.avatar_url ? "transparent" : "#111";
    } catch (e) {
      // ignore style errors in older browsers
    }
  }

  if (statBalance) {
    statBalance.textContent = `${Number(user?.balance || 0).toLocaleString("ru-RU")}₽`;
  }
  if (statOpened) {
    statOpened.textContent = String(openedCount);
  }
}

function toggleAuthOverlay(isOpen) {
  document.body.classList.toggle("modal-open", isOpen);
}

function blurModalFocus(modalElement) {
  if (!modalElement) {
    return;
  }

  const active = document.activeElement;
  if (active && modalElement.contains(active) && typeof active.blur === 'function') {
    active.blur();
  }
}

function renderNews() {
  if (!newsViewport) return;

  const item = newsItems[currentNewsIndex] || newsItems[0];
  if (!item) return;

  newsViewport.innerHTML = `
    <div class="news-banner__image">
      <img src="${item.image || './assets/items/ak47.png'}" alt="${item.title}" />
      <div class="news-banner__overlay">
        <span class="news-banner__badge">${item.pinned ? 'Закреплено' : 'Новость'}</span>
        <h2>${item.title}</h2>
        <p>${item.text}</p>
      </div>
    </div>
    <div class="news-banner__footer">
      <span>${item.pinned ? 'Закреплено' : 'Обновлено'}</span>
      <button type="button" class="news-banner__pin">📌</button>
    </div>
  `;
}

function showNews(index) {
  if (!newsItems.length) return;
  currentNewsIndex = (index + newsItems.length) % newsItems.length;
  renderNews();
}

function startNewsAutoRotate() {
  if (newsAutoRotateTimer) {
    clearInterval(newsAutoRotateTimer);
  }
  newsAutoRotateTimer = setInterval(() => {
    showNews(currentNewsIndex + 1);
  }, 10000);
}

function openAuthModal() {
  authModal.classList.add("open");
  authModal.setAttribute("aria-hidden", "false");
  toggleAuthOverlay(true);
}

function closeAuthModal() {
  authModal.classList.remove("open");
  authModal.setAttribute("aria-hidden", "true");
  toggleAuthOverlay(false);
}

async function persistCurrentUser(user) {
  if (!supabaseClient) {
    saveSession(user);
    return { ok: true, message: "Данные сохранены локально. Supabase клиент недоступен." };
  }

  const userId = Number(user.id);
  if (!Number.isInteger(userId)) {
    saveSession(user);
    return { ok: true, message: "Данные сохранены локально. Некорректный идентификатор пользователя." };
  }

  const payload = {
    balance: Number(user.balance || 0)
  };

  if (Array.isArray(user.inventory)) {
    payload.inventory = user.inventory;
  }

  if (Array.isArray(user.history)) {
    payload.history = user.history;
  }

  if (typeof user.server === 'string') {
    payload.server = user.server;
  }

  const { error } = await supabaseClient
    .from("users")
    .update(payload)
    .eq("id", userId);

  if (error) {
    if (payload.inventory || payload.history) {
      const { error: fallbackError } = await supabaseClient
        .from("users")
        .update({ balance: payload.balance })
        .eq("id", userId);

      saveSession(user);
      if (!fallbackError) {
        return { ok: true, message: "Баланс сохранён, но инвентарь/история не были синхронизированы в Supabase." };
      }
    }

    saveSession(user);
    return {
      ok: true,
      message: `Данные сохранены локально. Ошибка Supabase: ${error.message || 'Неизвестная ошибка'}`
    };
  }

  saveSession(user);
  return { ok: true };
}

async function registerUser(name, password, server) {
  if (!supabaseClient) {
    return { ok: false, message: "Укажи Supabase URL и anon key в script.js." };
  }

  const { data: existingUser, error: existingError } = await supabaseClient
    .from("users")
    .select("id")
    .eq("name", name)
    .maybeSingle();

  if (existingError) {
    return { ok: false, message: existingError.message };
  }

  if (existingUser) {
    return { ok: false, message: "Такое имя уже занято." };
  }

  const { data, error } = await supabaseClient
    .from("users")
    .insert([{ name, password, server: server || "", balance: 1000, inventory: [], history: [], status: "Active" }])
    .select("id, name, password, balance, avatar_url, server, inventory, history, status")
    .single();

  if (error) {
    return { ok: false, message: error.message };
  }

  currentUser = data;
  saveSession(currentUser);
  return { ok: true, message: "Аккаунт создан." };
}

async function loginUser(name, password) {
  if (!supabaseClient) {
    return { ok: false, message: "Укажи Supabase URL и anon key в script.js." };
  }

  const { data, error } = await supabaseClient
    .from("users")
    .select("id, name, password, balance, avatar_url, server, inventory, history, status")
    .eq("name", name)
    .eq("password", password)
    .maybeSingle();

  if (error) {
    return { ok: false, message: error.message };
  }

  if (!data) {
    return { ok: false, message: "Неверное имя или пароль." };
  }

  currentUser = data;
  saveSession(currentUser);
  return { ok: true, message: "Вход выполнен." };
}

function syncProfile() {
  updateProfileUI(currentUser);
  if (gameArea) {
    gameArea.classList.remove("is-hidden");
  }
  if (casesDock) {
    casesDock.classList.remove("is-hidden");
  }
}

function renderCases() {
  if (!casesList) {
    return;
  }

  casesList.innerHTML = cases
    .map(
      (gameCase, index) => {
        const image = gameCase.img || '';
        return `
        <button class="case-card-item ${index === activeCaseIndex ? "active" : ""}" type="button" data-index="${index}">
          <div class="case-card-item__image">${image ? `<img src="${image}" alt="${gameCase.name}" />` : '<span class="case-card-item__image-placeholder">🎁</span>'}</div>
          <div class="case-card-item__meta">
            <div class="case-card-item__title">${gameCase.name}</div>
            <div class="case-card-item__price">${gameCase.price}₽</div>
          </div>
        </button>
      `;
      }
    )
    .join("");
}

function setActiveCase(index) {
  activeCaseIndex = index;
  const gameCase = cases[activeCaseIndex];

  if (activeCaseName) {
    activeCaseName.textContent = gameCase.name;
  }
  if (activeCasePrice) {
    activeCasePrice.textContent = `${gameCase.price}₽`;
  }
  if (caseIcon) {
    caseIcon.textContent = gameCase.img || '🎁';
  }
  if (caseRarity) {
    caseRarity.textContent = gameCase.category || '';
  }
  if (caseDifficulty) {
    caseDifficulty.textContent = '';
  }
  if (caseDescription) {
    caseDescription.textContent = JSON.stringify(gameCase.chance || {});
  }
  if (casePreview) {
    casePreview.style.borderColor = gameCase.img ? 'transparent' : '#ffffff55';
    casePreview.style.boxShadow = 'inset 0 0 0 1px #ffffff22';
  }
  renderCases();
}

async function openCase() {
  const gameCase = cases[activeCaseIndex];
  if (!currentUser) {
    setMessage("Сначала войди в аккаунт.", true);
    openAuthModal();
    return;
  }

  const count = Number(selectedCaseCount || 1);
  const totalCost = Number(gameCase.price || 0) * count;
  if (currentUser.balance < totalCost) {
    setMessage("Недостаточно баланса для открытия кейса.", true);
    openAuthModal();
    return;
  }

  const currentInventory = Array.isArray(currentUser.inventory) ? currentUser.inventory : [];
  const currentHistory = Array.isArray(currentUser.history) ? currentUser.history : [];
  const selectedRewards = [];

  for (let i = 0; i < count; i += 1) {
    let reward = selectRewardByRarityWeights(gameCase.rewards, gameCase.chance);
    if (!reward) {
      reward = Array.isArray(gameCase.rewards) && gameCase.rewards.length > 0
        ? gameCase.rewards[Math.floor(Math.random() * gameCase.rewards.length)]
        : null;
    }

    if (!reward) {
      setMessage('Не удалось выбрать награду из кейса.', true);
      return;
    }

    selectedRewards.push({
      ...reward,
      value: Number(reward.value ?? reward.price ?? 0),
      img: reward.img || reward.image || '',
      emoji: reward.emoji || '',
      rarity: reward.rarity || 'Серый'
    });
  }

  const newInventory = [
    ...currentInventory,
    ...selectedRewards.map((reward) => ({ ...reward, date: new Date().toISOString() }))
  ];

  const newHistory = [
    ...currentHistory,
    ...selectedRewards.map((reward) => ({
      text: `Открыт ${gameCase.name} - получено ${reward.name}`,
      value: reward.value,
      date: new Date().toISOString()
    }))
  ];

  const nextUser = {
    ...currentUser,
    balance: currentUser.balance - totalCost,
    inventory: newInventory,
    history: newHistory
  };

  const saveResult = await persistCurrentUser(nextUser);
  if (!saveResult.ok) {
    setMessage(saveResult.message, true);
    return;
  }

  currentUser = nextUser;
  openedCount += count;
  updateProfileUI(currentUser);
  saveSession(currentUser);

  closeCaseDetailsModal();
  lastOpenedCaseRewardIndex = currentUser.inventory.length - count;
  startCaseOpenAnimation(gameCase, selectedRewards);
}

function openCaseOpenModal() {
  if (!caseOpenModal) return;
  caseOpenModal.classList.add('open');
  caseOpenModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function closeCaseOpenModal() {
  if (!caseOpenModal) return;
  blurModalFocus(caseOpenModal);
  caseOpenModal.classList.remove('open');
  caseOpenModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
}

function closeModal() {
  if (!resultModal) return;
  resultModal.classList.remove('open');
  resultModal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('modal-open');
  resultRewardIndex = null;
  resultRewards = [];
  resultInventoryOffset = null;
  selectedResultIndex = 0;
}

function formatRarityClass(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (['common', 'обычный', 'серый', 'gray'].includes(value)) return 'rarity-gray';
  if (['rare', 'редкий', 'зеленый', 'green'].includes(value)) return 'rarity-green';
  if (['blue', 'синий'].includes(value)) return 'rarity-blue';
  if (['epic', 'эпик', 'фиолетовый', 'purple'].includes(value)) return 'rarity-purple';
  if (['legendary', 'легендарный', 'золотой', 'gold'].includes(value)) return 'rarity-gold';
  if (['mythic', 'мифический', 'red', 'красный'].includes(value)) return 'rarity-red';
  return 'rarity-gray';
}

function renderRewardVisual(image, name) {
  const src = String(image || '').trim();
  if (!src) {
    return '🎁';
  }

  const isImagePath = /^(?:https?:\/\/|\.\/|\.\.\/|\/).+\.(?:png|jpe?g|webp|gif|svg)$/i.test(src);
  if (isImagePath) {
    return `<img src="${src}" alt="${name || 'Предмет'}" />`;
  }

  return src;
}

function buildCaseOpenRows(finalRewards) {
  const rows = [];
  if (finalRewards.length === 2) {
    rows.push(finalRewards.map((reward) => ({ finalReward: reward, narrow: true })));
    return rows;
  }

  if (finalRewards.length === 3) {
    finalRewards.forEach((reward) => {
      rows.push([{ finalReward: reward, narrow: false }]);
    });
    return rows;
  }

  if (finalRewards.length === 5) {
    rows.push(finalRewards.slice(0, 2).map((reward) => ({ finalReward: reward, narrow: true })));
    rows.push([{ finalReward: finalRewards[2], narrow: false }]);
    rows.push(finalRewards.slice(3).map((reward) => ({ finalReward: reward, narrow: true })));
    return rows;
  }

  if (finalRewards.length === 10) {
    for (let i = 0; i < finalRewards.length; i += 2) {
      rows.push(finalRewards.slice(i, i + 2).map((reward) => ({ finalReward: reward, narrow: true })));
    }
    return rows;
  }

  rows.push(finalRewards.map((reward) => ({ finalReward: reward, narrow: false })));
  return rows;
}

function buildTapeWrapper(gameCase, reward, narrow) {
  const tapeItems = buildTapeCells(gameCase.rewards || [reward], reward, narrow ? 15 : 23);
  return `
    <div class="case-open-tape-wrapper${narrow ? ' narrow' : ''}">
      <div class="case-open-tape">
        ${tapeItems
          .map((item) => {
            const rarityClass = formatRarityClass(item.rarity || 'Серый');
            const visual = renderRewardVisual(item.img || item.emoji || '', item.name);
            return `
              <div class="case-open-cell ${rarityClass}">
                <div class="case-open-cell-icon">${visual}</div>
                <strong class="cell-name">${item.name || 'Предмет'}</strong>
              </div>
            `;
          })
          .join('')}
      </div>
      <div class="case-open-pointer"></div>
    </div>
  `;
}

function buildTapeCells(caseRewards, finalReward, count = 23) {
  const itemCount = Number.isFinite(count) ? count : 23;
  const cells = [];
  const randomItem = () => caseRewards[Math.floor(Math.random() * caseRewards.length)];
  const centerIndex = Math.floor(count / 2);

  for (let i = 0; i < count; i += 1) {
    if (i === centerIndex) {
      cells.push(finalReward);
      continue;
    }
    const item = randomItem() || finalReward;
    cells.push(item);
  }

  if (count > 7) {
    cells[centerIndex - 2] = finalReward;
    cells[centerIndex + 2] = finalReward;
  }

  return cells;
}

function updateResultNavButtons() {
  const hasMultiple = Array.isArray(resultRewards) && resultRewards.length > 1;
  if (resultPrevBtn) {
    resultPrevBtn.hidden = !hasMultiple;
    resultPrevBtn.disabled = !hasMultiple || selectedResultIndex <= 0;
  }
  if (resultNextBtn) {
    resultNextBtn.hidden = !hasMultiple;
    resultNextBtn.disabled = !hasMultiple || selectedResultIndex >= resultRewards.length - 1;
  }
}

function selectResultItem(index, direction = null) {
  if (!Array.isArray(resultRewards) || resultRewards.length === 0) return;
  const previousIndex = selectedResultIndex;
  selectedResultIndex = Math.max(0, Math.min(index, resultRewards.length - 1));
  if (direction === null) {
    direction = selectedResultIndex > previousIndex ? 'right' : selectedResultIndex < previousIndex ? 'left' : null;
  }
  const reward = resultRewards[selectedResultIndex];
  if (!reward) return;

  const rarityClass = formatRarityClass(reward.rarity || reward.rarity_name || 'Серый');
  rewardEmoji.innerHTML = renderRewardVisual(reward.img || reward.emoji || '', reward.name);
  rewardName.textContent = reward.name || 'Предмет';
  rewardValue.textContent = `+ ${Number(reward.value || reward.price || 0).toLocaleString('ru-RU')}₽`;

  const rewardVisual = document.querySelector('.reward-visual');
  if (rewardVisual) {
    rewardVisual.className = `reward-visual ${rarityClass}`;
  }

  if (resultInventoryOffset !== null) {
    resultRewardIndex = resultInventoryOffset + selectedResultIndex;
  } else {
    resultRewardIndex = null;
  }

  if (resultCounter) {
    resultCounter.textContent = `${selectedResultIndex + 1} / ${resultRewards.length}`;
  }

  if (resultNavWrapper) {
    resultNavWrapper.classList.toggle('single-result', resultRewards.length === 1);
  }

  if (resultNavPanel && direction) {
    resultNavPanel.classList.remove("slide-left", "slide-right");
    void resultNavPanel.offsetWidth;
    resultNavPanel.classList.add(`slide-${direction}`);
    window.setTimeout(() => {
      if (resultNavPanel) {
        resultNavPanel.classList.remove("slide-left", "slide-right");
      }
    }, 300);
  }

  updateResultNavButtons();
}

function openResultModal(rewards, inventoryOffset = null) {
  if (!resultModal || !rewards) return;

  resultRewards = Array.isArray(rewards) ? rewards : [rewards];
  resultInventoryOffset = Number.isFinite(inventoryOffset) ? inventoryOffset : null;
  selectedResultIndex = 0;
  selectResultItem(selectedResultIndex);
  updateResultNavButtons();

  resultModal.classList.add('open');
  resultModal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('modal-open');
}

function startCaseOpenAnimation(gameCase, finalRewards) {
  if (!caseOpenTapes || !caseOpenTitle || !caseOpenModal || !caseOpenResult) return;

  caseOpenTitle.textContent = selectedCaseCount > 1 ? `${gameCase.name} x${selectedCaseCount}` : gameCase.name || 'Кейс';
  caseOpenResult.classList.remove('revealed');
  caseOpenResult.style.pointerEvents = 'none';
  if (caseOpenModal) {
    caseOpenModal.classList.toggle('x10', selectedCaseCount === 10);
  }

  const lastReward = finalRewards[finalRewards.length - 1];
  caseOpenResultEmoji.innerHTML = renderRewardVisual(lastReward.img || lastReward.emoji || '', lastReward.name);
  caseOpenResultName.textContent = lastReward.name || 'Предмет';
  caseOpenResultValue.textContent = `+ ${Number(lastReward.value || lastReward.price || 0).toLocaleString('ru-RU')}₽`;

  const rows = buildCaseOpenRows(finalRewards);
  caseOpenTapes.innerHTML = rows
    .map((row) => {
      const rowClasses = ['case-open-row'];
      if (row.length === 2) {
        rowClasses.push('two-columns');
      }
      return `<div class="${rowClasses.join(' ')}">${row.map((entry) => buildTapeWrapper(gameCase, entry.finalReward, entry.narrow)).join('')}</div>`;
    })
    .join('');

  openCaseOpenModal();

  const tapeElements = Array.from(caseOpenTapes.querySelectorAll('.case-open-tape'));
  const animationData = tapeElements.map((tape) => {
    const itemWidth = tape.children[0]?.getBoundingClientRect().width || 176;
    const visibleWidth = tape.parentElement?.clientWidth || 720;
    const targetIndex = Math.floor(tape.children.length / 2);
    const offsetX = -((targetIndex * (itemWidth + 12)) - visibleWidth / 2 + itemWidth / 2);
    return { tape, offsetX };
  });

  const animateTape = () => {
    if (window.gsap && typeof gsap.to === 'function' && typeof gsap.set === 'function') {
      animationData.forEach(({ tape }, index) => {
        gsap.set(tape, { x: 0, force3D: true });
        gsap.to(tape, {
          duration: 3.0,
          x: animationData[index].offsetX,
          ease: 'power3.out',
          overwrite: true,
          onComplete: index === animationData.length - 1 ? () => {
            closeCaseOpenModal();
            openResultModal(finalRewards, lastOpenedCaseRewardIndex);
          } : undefined
        });
      });
      return;
    }

    setTimeout(() => {
      closeCaseOpenModal();
      openResultModal(finalRewards, lastOpenedCaseRewardIndex);
    }, 600);
  };

  requestAnimationFrame(animateTape);
}

function openCaseDetailsModal(caseIndex) {
  if (!caseModal) {
    return;
  }

  const gameCase = cases[caseIndex];
  if (!gameCase) {
    return;
  }

  const title = gameCase.name || "Case";
  const price = `${Number(gameCase.price || 0).toLocaleString('ru-RU')} ₽`;
  const caseImage = gameCase.img || "";

  const itemsData = Array.isArray(gameCase.rewards)
    ? gameCase.rewards.map((r) => ({
        image: normalizeItemImagePath(r.img || r.image || ""),
        name: r.name || "Предмет",
        emoji: String(r.emoji || "").trim(),
        price: Number(r.price ?? r.value ?? 0),
        rarity: r.rarity || ''
      }))
    : [];

  caseModalImage.innerHTML = caseImage
    ? `<img src="${normalizeItemImagePath(caseImage)}" alt="${title}" />`
    : '🎁';
  caseModalTitle.textContent = title;
  caseModalPrice.textContent = price;

  function mapRarityClass(raw) {
    const value = String(raw || '').trim().toLowerCase();
    if (['common', 'обычный', 'серый', 'gray'].includes(value)) return 'rarity-gray';
    if (['rare', 'редкий', 'зеленый', 'green'].includes(value)) return 'rarity-green';
    if (['blue', 'синий'].includes(value)) return 'rarity-blue';
    if (['epic', 'эпик', 'фиолетовый', 'purple'].includes(value)) return 'rarity-purple';
    if (['legendary', 'легендарный', 'золотой', 'gold'].includes(value)) return 'rarity-gold';
    if (['mythic', 'мифический', 'red', 'красный'].includes(value)) return 'rarity-red';
    return '';
  }

  caseModalItems.innerHTML = itemsData
    .map((it) => {
      const rClass = mapRarityClass(it.rarity || '');
      const priceText = it.price ? it.price.toLocaleString('ru-RU') + '₽' : '';
      return `\n      <div class="case-modal__item">\n        <div class="case-item__visual ${rClass}">\n          ${it.image ? `<img src="${it.image}" alt="${it.name}" />` : ''}\n          <div class="case-item__badge">\n            <span class="case-item__price">${priceText}</span>\n          </div>\n        </div>\n        <div class="case-item__meta">\n          <div class="case-item__name">${it.name}</div>\n        </div>\n      </div>\n    `;
    })
    .join("");

  caseModal.classList.add("open");
  caseModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  try {
    if (caseModalCard) {
      caseModalCard.scrollTop = 0;
      caseModalCard.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  } catch (e) {
    // ignore
  }
}

function closeCaseDetailsModal() {
  if (!caseModal) {
    return;
  }

  blurModalFocus(caseModal);
  caseModal.classList.remove("open");
  caseModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

caseCountButtons.forEach((button) => {
  button.addEventListener("click", () => {
    selectedCaseCount = Number(button.dataset.count || 1);
    caseCountButtons.forEach((item) => item.classList.toggle("active", item === button));
  });
});

document.querySelectorAll("[data-close-case-modal]").forEach((element) => {
  element.addEventListener("click", closeCaseDetailsModal);
});

if (caseModal) {
  caseModal.addEventListener("click", (event) => {
    if (event.target === caseModal) {
      closeCaseDetailsModal();
    }
  });
}

caseOpenCloseBtns.forEach((button) => {
  button.addEventListener('click', closeCaseOpenModal);
});

if (caseOpenModal) {
  caseOpenModal.addEventListener('click', (event) => {
    if (event.target === caseOpenModal) {
      closeCaseOpenModal();
    }
  });
}

if (caseOpenContinueBtn) {
  caseOpenContinueBtn.addEventListener('click', () => {
    closeCaseOpenModal();
    lastOpenedCaseRewardIndex = null;
  });
}

if (openCaseFastBtn) {
  openCaseFastBtn.addEventListener('click', openCase);
}

if (casesList) {
  casesList.addEventListener("click", (event) => {
    const card = event.target.closest(".case-card-item");
    if (!card) {
      return;
    }

    const index = Number(card.dataset.index);
    if (!Number.isNaN(index)) {
      setActiveCase(index);
      openCaseDetailsModal(index);
    }
  });
}

if (openCaseBtn) {
  openCaseBtn.addEventListener("click", openCase);
}
if (closeModalBtn) {
  closeModalBtn.addEventListener("click", closeModal);
}

async function sellSelectedResultItem() {
  if (selectedResultIndex === null || resultRewardIndex === null || !currentUser) {
    closeModal();
    return;
  }

  const item = currentUser.inventory?.[resultRewardIndex];
  if (!item) {
    closeModal();
    return;
  }

  const sold = await sellInventoryItem(item, resultRewardIndex);
  if (!sold) {
    return;
  }

  if (!Array.isArray(resultRewards)) {
    closeModal();
    return;
  }

  resultRewards.splice(selectedResultIndex, 1);

  if (resultRewards.length === 0) {
    closeModal();
    return;
  }

  if (selectedResultIndex >= resultRewards.length) {
    selectedResultIndex = resultRewards.length - 1;
  }

  selectResultItem(selectedResultIndex);
}

if (resultSellBtn) {
  resultSellBtn.addEventListener("click", sellSelectedResultItem);
}

if (resultPrevBtn) {
  resultPrevBtn.addEventListener("click", () => {
    selectResultItem(selectedResultIndex - 1, 'left');
  });
}

if (resultNextBtn) {
  resultNextBtn.addEventListener("click", () => {
    selectResultItem(selectedResultIndex + 1, 'right');
  });
}


authModal.addEventListener("click", (event) => {
  if (event.target.dataset.closeAuth !== undefined) {
    closeAuthModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeModal();
    closeAuthModal();
    closeSellItemModal();
    closeCaseOpenModal();
  }
});

authTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setAuthMode(tab.dataset.mode);
  });
});

serverTrigger.addEventListener("click", () => {
  const isOpen = serverModal.hasAttribute("hidden");
  if (isOpen) {
    serverModal.removeAttribute("hidden");
    serverTrigger.setAttribute("aria-expanded", "true");
  }
});

serverModalClose.addEventListener("click", () => {
  serverModal.setAttribute("hidden", "true");
  serverTrigger.setAttribute("aria-expanded", "false");
});

serverOptions.forEach((option) => {
  option.addEventListener("click", async () => {
    selectedServer = option.dataset.server;
    serverSelected.textContent = selectedServer;
    serverOptions.forEach((item) => item.classList.toggle("selected", item === option));
    serverModal.setAttribute("hidden", "true");
    serverTrigger.setAttribute("aria-expanded", "false");

    // Если пользователь авторизирован и открывается смена сервера из профиля
    if (currentUser && currentUser.id && supabaseClient) {
      const { error } = await supabaseClient
        .from("users")
        .update({ server: selectedServer })
        .eq("id", currentUser.id);

      if (!error) {
        currentUser.server = selectedServer;
        saveSession(currentUser);
        updateProfileUI(currentUser);
        if (document.querySelector(".profile-modal.open")) {
          updateProfileModal();
        }
      }
    }
  });
});

serverModal.addEventListener("click", (event) => {
  if (event.target === serverModal) {
    serverModal.setAttribute("hidden", "true");
    serverTrigger.setAttribute("aria-expanded", "false");
  }
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const name = authNameInput.value.trim();
  const lastname = authLastnameInput.value.trim();
  const password = authPasswordInput.value;
  const nicknamePattern = /^[A-Za-z0-9_]+$/;
  const passwordPattern = /^[A-Za-z0-9]+$/;

  if (!name || !lastname || !password) {
    setMessage("Заполни все поля.", true);
    return;
  }

  if (authMode === "register" && !selectedServer) {
    setMessage("Выбери сервер.", true);
    return;
  }

  if (!nicknamePattern.test(name)) {
    setMessage("Имя должно содержать только английские буквы, цифры и подчёркивания.", true);
    return;
  }

  if (!nicknamePattern.test(lastname)) {
    setMessage("Фамилия должна содержать только английские буквы, цифры и подчёркивания.", true);
    return;
  }

  if (!passwordPattern.test(password) || password.length < 6) {
    setMessage("Пароль должен быть только на английском и минимум 6 символов.", true);
    return;
  }

  const identifier = `${name}_${lastname}`;
  const result = authMode === "register"
    ? await registerUser(identifier, password, selectedServer)
    : await loginUser(identifier, password);

  setMessage(result.message, !result.ok);

  if (result.ok) {
    authForm.reset();
    syncProfile();
    renderCases();
    setActiveCase(activeCaseIndex);
    closeAuthModal();
  }
});

async function hydrateCurrentUser() {
  if (!currentUser || currentUser.id || !supabaseClient) {
    return;
  }

  const { data, error } = await supabaseClient
    .from("users")
    .select("id, name, password, balance, avatar_url, server, inventory, history, status")
    .eq("name", currentUser.name)
    .maybeSingle();

  if (!error && data) {
    currentUser = data;
    saveSession(currentUser);
  }
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    currentUser = null;
    saveSession(null);
    syncProfile();
    setAuthMode("login");
    setMessage("Сессия завершена.");
    openAuthModal();
  });
}

// Profile Modal Elements
const profileModal = document.getElementById("profile-modal");
const profileAvatarLarge = document.getElementById("profile-avatar-large");
const avatarFileInput = document.getElementById("avatar-file-input");
const profileNicknameText = document.getElementById("profile-nickname-text");
const profileServerText = document.getElementById("profile-server-text");
const profileStatsBalance = document.getElementById("profile-stats-balance");
const profileStatsStatus = document.getElementById("profile-stats-status");
const profileTabs = Array.from(document.querySelectorAll(".profile-tab"));
const profileTabContents = Array.from(document.querySelectorAll(".profile-tab-content"));
const profileEditNameBtn = document.getElementById("profile-edit-name-btn");
const profileEditServerBtn = document.getElementById("profile-edit-server-btn");
const profileLogoutBtn = document.getElementById("profile-logout-btn");
const inventoryList = document.getElementById("inventory-list");
const historyList = document.getElementById("history-list");
const promoCodeInput = document.getElementById("promo-code-input");
const bonusBtn = document.getElementById("bonus-btn");
const bonusMessage = document.getElementById("bonus-message");
const sellModal = document.getElementById("sell-item-modal");
const sellItemVisual = document.getElementById("sell-item-visual");
const sellItemName = document.getElementById("sell-item-name");
const sellItemPrice = document.getElementById("sell-item-price");
const sellItemCommission = document.getElementById("sell-item-commission");
const sellItemNet = document.getElementById("sell-item-net");
const sellItemConfirmBtn = document.getElementById("sell-item-confirm-btn");
const sellItemCancelBtn = document.getElementById("sell-item-cancel-btn");
let selectedInventoryItem = null;

function openProfileModal() {
  profileModal.classList.add("open");
  profileModal.setAttribute("aria-hidden", "false");
  toggleAuthOverlay(true);
  updateProfileModal();
}

function closeProfileModal() {
  profileModal.classList.remove("open");
  profileModal.setAttribute("aria-hidden", "true");
  toggleAuthOverlay(false);
}

function updateProfileModal() {
  if (!currentUser) return;

  profileNicknameText.textContent = currentUser.name;
  profileServerText.textContent = currentUser.server || "Не выбран";
  profileAvatarLarge.textContent = currentUser.avatar_url ? "" : getInitials(currentUser.name);
  profileAvatarLarge.style.backgroundImage = currentUser.avatar_url ? `url(${currentUser.avatar_url})` : "";
  profileAvatarLarge.style.backgroundSize = currentUser.avatar_url ? "cover" : "initial";
  profileAvatarLarge.style.backgroundPosition = "center";
  profileAvatarLarge.style.backgroundRepeat = "no-repeat";
  profileAvatarLarge.style.color = currentUser.avatar_url ? "transparent" : "#fff";
  profileStatsBalance.textContent = `${Number(currentUser.balance || 0).toLocaleString("ru-RU")}₽`;
  profileStatsStatus.textContent = currentUser.status || "Active";
  
  renderInventory();
  renderHistory();
  promoCodeInput.value = "";
  bonusMessage.textContent = "";
}

function renderInventory() {
  if (!currentUser?.inventory || !Array.isArray(currentUser.inventory) || currentUser.inventory.length === 0) {
    inventoryList.innerHTML = '<p class="empty-state">Инвентарь пуст</p>';
    return;
  }

  inventoryList.innerHTML = currentUser.inventory
    .map((item, index) => {
      const rarityClass = formatRarityClass(item.rarity || 'Серый');
      const visual = renderRewardVisual(item.img || item.emoji || '', item.name);
      const valueText = Number(item.value || item.price || 0);
      return `
        <button class="inventory-item ${rarityClass}" type="button" data-index="${index}">
          <div class="inventory-item-icon">${visual}</div>
          <div class="inventory-item-info">
            <p class="inventory-item-name">${item.name}</p>
            <p class="inventory-item-value">${valueText ? "+ " + valueText.toLocaleString("ru-RU") + "₽" : ""}</p>
          </div>
        </button>
      `;
    })
    .join("");
}

function renderHistory() {
  if (!currentUser?.history || !Array.isArray(currentUser.history) || currentUser.history.length === 0) {
    historyList.innerHTML = '<p class="empty-state">История пуста</p>';
    return;
  }

  historyList.innerHTML = currentUser.history
    .slice()
    .reverse()
    .map(
      (entry) => `
        <div class="history-item">
          <div class="history-item-text">${entry.text || entry.name || "Событие"}</div>
          <div class="history-item-date">${entry.date ? new Date(entry.date).toLocaleDateString("ru-RU") : ""}</div>
        </div>
      `
    )
    .join("");
}

profileTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const tabName = tab.dataset.tab;
    profileTabs.forEach((t) => t.classList.toggle("active", t === tab));
    profileTabContents.forEach((content) => {
      content.classList.toggle("active", content.dataset.tabContent === tabName);
    });
  });
});

function openSellItemModal(item, index) {
  selectedInventoryItem = { item, index };

  const fullValue = Number(item.value || 0);
  const commission = Math.round(fullValue * 0.2);
  const payout = Math.max(0, fullValue - commission);

  sellItemName.textContent = item.name || "Предмет";
  sellItemPrice.textContent = `${fullValue.toLocaleString("ru-RU")}₽`;
  sellItemCommission.textContent = `Комиссия 20% — ${commission.toLocaleString("ru-RU")}₽`;
  sellItemNet.textContent = `Получите ${payout.toLocaleString("ru-RU")}₽`;

  const sellImage = normalizeItemImagePath(item.image || item.img || "");
  sellItemVisual.textContent = sellImage ? "" : item.emoji || "📦";
  sellItemVisual.style.backgroundImage = sellImage ? `url(${sellImage})` : "";
  sellItemVisual.style.backgroundSize = sellImage ? "contain" : "";
  sellItemVisual.style.backgroundPosition = "center";
  sellItemVisual.style.backgroundRepeat = "no-repeat";

  sellModal.classList.add("open");
  sellModal.setAttribute("aria-hidden", "false");
}

function closeSellItemModal() {
  selectedInventoryItem = null;
  sellModal.classList.remove("open");
  sellModal.setAttribute("aria-hidden", "true");
}

async function sellInventoryItem(item, index) {
  if (!item || !currentUser) {
    return false;
  }

  const fullValue = Number(item.value || 0);
  const payout = Math.max(0, Math.round(fullValue * 0.8));
  const nextInventory = (Array.isArray(currentUser.inventory) ? currentUser.inventory : []).filter((_, itemIndex) => itemIndex !== index);
  const nextHistory = Array.isArray(currentUser.history) ? [...currentUser.history] : [];

  nextHistory.push({
    text: `Продан ${item.name}`,
    value: payout,
    date: new Date().toISOString()
  });

  const nextUser = {
    ...currentUser,
    balance: currentUser.balance + payout,
    inventory: nextInventory,
    history: nextHistory
  };

  const saveResult = await persistCurrentUser(nextUser);
  if (!saveResult.ok) {
    alert(saveResult.message || "Не удалось продать предмет.");
    return false;
  }

  currentUser = nextUser;
  saveSession(currentUser);
  updateProfileUI(currentUser);
  updateProfileModal();
  return true;
}

inventoryList.addEventListener("click", (event) => {
  const itemButton = event.target.closest(".inventory-item");
  if (!itemButton) {
    return;
  }

  const index = Number(itemButton.dataset.index);
  const item = currentUser?.inventory?.[index];

  if (item) {
    openSellItemModal(item, index);
  }
});

sellItemConfirmBtn.addEventListener("click", async () => {
  if (!selectedInventoryItem || !currentUser) {
    return;
  }

  const { item, index } = selectedInventoryItem;
  const sold = await sellInventoryItem(item, index);
  if (sold) {
    closeSellItemModal();
  }
});

profileAvatarLarge.addEventListener("click", () => {
  if (!currentUser) {
    return;
  }
  avatarFileInput.click();
});

function dataUrlToBlob(dataUrl) {
  const arr = dataUrl.split(",");
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

async function convertImageToWebp(file) {
  const imageUrl = URL.createObjectURL(file);
  const image = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = imageUrl;
  });

  const canvas = document.createElement("canvas");
  const maxSize = 512;
  const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
  canvas.width = Math.round(image.width * scale);
  canvas.height = Math.round(image.height * scale);

  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL("image/webp", 0.9);
  URL.revokeObjectURL(imageUrl);
  return dataUrl;
}

async function uploadProfileAvatar(file) {
  if (!currentUser || !supabaseClient) {
    return;
  }

  const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
  if (!allowedTypes.includes(file.type)) {
    alert("Поддерживаются только изображения JPG, PNG, GIF, WebP.");
    return;
  }

  if (file.size > 2 * 1024 * 1024) {
    alert("Размер файла не должен превышать 2 МБ.");
    return;
  }

  const avatarDataUrl = await convertImageToWebp(file);

  const { error: updateError } = await supabaseClient
    .from("users")
    .update({ avatar_url: avatarDataUrl })
    .eq("id", currentUser.id);

  if (updateError) {
    alert("Ошибка сохранения аватарки: " + updateError.message);
    return;
  }

  currentUser.avatar_url = avatarDataUrl;
  saveSession(currentUser);
  updateProfileUI(currentUser);
  updateProfileModal();
  setMessage("Аватарка обновлена.");
}

avatarFileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  await uploadProfileAvatar(file);
  event.target.value = "";
});

profileEditNameBtn.addEventListener("click", async () => {
  const newName = prompt("Введите новый никнейм:", currentUser.name);
  if (!newName || newName === currentUser.name) return;

  if (!supabaseClient) {
    alert("Ошибка подключения к базе данных.");
    return;
  }

  const { error } = await supabaseClient
    .from("users")
    .update({ name: newName })
    .eq("id", currentUser.id);

  if (error) {
    alert("Ошибка при изменении никнейма: " + error.message);
    return;
  }

  currentUser.name = newName;
  saveSession(currentUser);
  updateProfileUI(currentUser);
  updateProfileModal();
});

profileEditServerBtn.addEventListener("click", () => {
  serverTrigger.click();
});

profileLogoutBtn.addEventListener("click", () => {
  currentUser = null;
  saveSession(null);
  syncProfile();
  setAuthMode("login");
  setMessage("Сессия завершена.");
  closeProfileModal();
  openAuthModal();
});

bonusBtn.addEventListener("click", async () => {
  const promo = promoCodeInput.value.trim();
  if (!promo) {
    bonusMessage.textContent = "Введите промокод.";
    bonusMessage.style.color = "var(--muted)";
    return;
  }

  if (!supabaseClient) {
    bonusMessage.textContent = "Ошибка подключения.";
    bonusMessage.style.color = "#ff8f8f";
    return;
  }

  // Пример проверки промокода (можете добавить логику на сервере)
  // Сейчас просто добавляем бонус
  const bonusAmount = 1000;
  const newBalance = currentUser.balance + bonusAmount;

  const { error } = await supabaseClient
    .from("users")
    .update({ balance: newBalance })
    .eq("id", currentUser.id);

  if (error) {
    bonusMessage.textContent = "Ошибка активации промокода.";
    bonusMessage.style.color = "#ff8f8f";
    return;
  }

  currentUser.balance = newBalance;
  saveSession(currentUser);
  updateProfileUI(currentUser);
  bonusMessage.textContent = `Промокод активирован! +${bonusAmount}₽`;
  bonusMessage.style.color = "var(--good)";
  promoCodeInput.value = "";
});

profileModal.addEventListener("click", (event) => {
  if (event.target.dataset.closeProfile !== undefined) {
    closeProfileModal();
  }
});

sellModal.addEventListener("click", (event) => {
  if (event.target.dataset.closeSellItem !== undefined || event.target === sellModal) {
    closeSellItemModal();
  }
});

sellItemCancelBtn.addEventListener("click", closeSellItemModal);

// Обновляем логику открытия профиля
profileChip.addEventListener("click", () => {
  if (!currentUser) {
    setAuthMode("login");
    openAuthModal();
  } else {
    openProfileModal();
  }
});

if (navProfileButton) {
  navProfileButton.addEventListener("click", () => {
    if (!currentUser) {
      setAuthMode("login");
      openAuthModal();
    } else {
      openProfileModal();
    }
  });
}

async function initApp() {
  await refreshDataFromSupabase();
  renderNews();
  startNewsAutoRotate();
  await hydrateCurrentUser();
  setActiveCase(0);
  setAuthMode("login");
  syncProfile();
}

initApp();
