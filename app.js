"use strict";

/* ==========================================================================
   notes — app.js
   D1(本文・メタデータ) + R2(画像のみ) 構成。
   検索・タグ絞り込み・ページングはすべてWorkers(D1)側で行う。
   アクセス制御は Cloudflare Access が行うため、アプリ側に認証ロジックは持たない。
   ========================================================================== */

// CONFIG は config.js で定義される(このファイルでは触らない)

// CONFIGが未設定のまま(プレースホルダのまま)だと、fetch()に渡すURLとして不正な
// 文字("<" ">")を含むため、fetch()はネットワークリクエストを送る前に
// 同期的にTypeErrorを投げる。その結果 Network タブに何も出ず、catchブロックで
// ログを取っていないと原因が全く見えなくなる。起動時に必ず気付けるようにする。
function assertConfigIsSet() {
  const placeholderPattern = /<.*>/;
  const problems = [];
  if (placeholderPattern.test(CONFIG.indexUrl)) {
    problems.push(`CONFIG.indexUrl がプレースホルダのままです: ${CONFIG.indexUrl}`);
  }
  if (placeholderPattern.test(CONFIG.entryBaseUrl)) {
    problems.push(`CONFIG.entryBaseUrl がプレースホルダのままです: ${CONFIG.entryBaseUrl}`);
  }
  if (problems.length > 0) {
    const message = problems.join(" / ");
    console.error(`[notes] CONFIG設定エラー: ${message}`);
    return message;
  }
  return null;
}

const PAGE_SIZE = 20;
const UNTITLED_TAG = "タイトル未設定";
const DEFAULT_SORT = "pinned";
const SORT_STORAGE_KEY = "notes:sort";
const DRAFT_STORAGE_PREFIX = "notes:draft:";
const DRAFT_SAVE_DELAY = 350;

// アプリの状態はここだけで持つ（localStorageは使わない）
const state = {
  items: [],
  total: 0,
  hasMore: false,
  selectedId: null,
  query: "",
  activeTag: null,
  sort: DEFAULT_SORT,
  theme: "light",
  knownTags: new Set(), // タグチップ表示用。読み込んだ範囲から見えたタグを蓄積するだけの簡易実装
};

let searchDebounceTimer = null;
let draftSaveTimer = null;

/* ---- DOM references ---- */

const el = {
  list: document.getElementById("note-list"),
  listStatus: document.getElementById("note-list-status"),
  view: document.getElementById("note-view"),
  viewStatus: document.getElementById("note-view-status"),
  themeToggle: document.getElementById("theme-toggle"),
  newNoteButton: document.getElementById("new-note-button"),
  searchInput: document.getElementById("search-input"),
  sortSelect: document.getElementById("sort-select"),
  tagFilter: document.getElementById("tag-filter"),
  loadMoreButton: document.getElementById("load-more-button"),
};

function isCompactScreen() {
  return window.matchMedia("(max-width: 767px)").matches;
}

function normalizeSortValue(value) {
  return ["pinned", "updated", "created", "title"].includes(value) ? value : DEFAULT_SORT;
}

function getStoredSort() {
  try {
    return normalizeSortValue(localStorage.getItem(SORT_STORAGE_KEY) || DEFAULT_SORT);
  } catch (err) {
    return DEFAULT_SORT;
  }
}

function saveStoredSort(sort) {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, sort);
  } catch (err) {
    // noop
  }
}

function getDraftStorageKey(entryId) {
  return `${DRAFT_STORAGE_PREFIX}${entryId || "new"}`;
}

function readDraft(entryId) {
  try {
    const raw = localStorage.getItem(getDraftStorageKey(entryId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function writeDraft(entryId, draft) {
  try {
    localStorage.setItem(getDraftStorageKey(entryId), JSON.stringify(draft));
  } catch (err) {
    // noop
  }
}

function clearDraft(entryId) {
  try {
    localStorage.removeItem(getDraftStorageKey(entryId));
  } catch (err) {
    // noop
  }
}

function isTextEntryElement(element) {
  if (!element || !(element instanceof HTMLElement)) {
    return false;
  }
  return element.matches("input, textarea, select") || element.isContentEditable;
}

function insertMarkdownInline(textarea, before, after = "") {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = textarea.value.substring(start, end);
  const nextValue =
    textarea.value.substring(0, start) + before + selected + after + textarea.value.substring(end);

  textarea.value = nextValue;
  textarea.focus();
  textarea.selectionStart = start + before.length;
  textarea.selectionEnd = start + before.length + selected.length;
}

function insertMarkdownLinePrefix(textarea, prefix) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEndIndex = value.indexOf("\n", end);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
  const block = value.slice(lineStart, lineEnd);
  const nextBlock = block
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");

  textarea.value = value.slice(0, lineStart) + nextBlock + value.slice(lineEnd);
  textarea.focus();
  textarea.selectionStart = lineStart;
  textarea.selectionEnd = lineStart + nextBlock.length;
}

function syncScrollByRatio(from, to) {
  const fromRange = from.scrollHeight - from.clientHeight;
  const toRange = to.scrollHeight - to.clientHeight;
  if (fromRange <= 0 || toRange <= 0) {
    to.scrollTop = 0;
    return;
  }

  const ratio = from.scrollTop / fromRange;
  to.scrollTop = ratio * toRange;
}

function handleTextareaTabIndent(event, textarea) {
  if (event.key !== "Tab") {
    return false;
  }

  event.preventDefault();

  const indent = "  ";
  const value = textarea.value;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;

  const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineEndIndex = value.indexOf("\n", end);
  const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;

  const before = value.slice(0, lineStart);
  const block = value.slice(lineStart, lineEnd);
  const after = value.slice(lineEnd);

  // Shift+Tab は字下げ解除、Tab は字下げ追加。
  if (event.shiftKey) {
    const lines = block.split("\n");
    let removedFromFirstLine = 0;
    let removedBeforeSelectionEnd = 0;

    const nextLines = lines.map((line, index) => {
      if (line.startsWith(indent)) {
        if (index === 0) removedFromFirstLine = indent.length;
        removedBeforeSelectionEnd += indent.length;
        return line.slice(indent.length);
      }
      if (line.startsWith("\t")) {
        if (index === 0) removedFromFirstLine = 1;
        removedBeforeSelectionEnd += 1;
        return line.slice(1);
      }
      return line;
    });

    const nextBlock = nextLines.join("\n");
    textarea.value = before + nextBlock + after;

    const nextStart = Math.max(lineStart, start - removedFromFirstLine);
    const nextEnd = Math.max(nextStart, end - removedBeforeSelectionEnd);
    textarea.selectionStart = nextStart;
    textarea.selectionEnd = nextEnd;
    return true;
  }

  const lines = block.split("\n");
  const nextBlock = lines.map((line) => `${indent}${line}`).join("\n");
  textarea.value = before + nextBlock + after;

  const lineCount = lines.length;
  const insertedBeforeStart = indent.length;
  const insertedBeforeEnd = indent.length * lineCount;
  textarea.selectionStart = start + insertedBeforeStart;
  textarea.selectionEnd = end + insertedBeforeEnd;
  return true;
}

function getThemeSettingsUrl() {
  const url = new URL(CONFIG.indexUrl);
  url.pathname = "/api/settings/theme";
  url.search = "";
  return url.toString();
}

function normalizeThemeValue(value) {
  return value === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
  state.theme = normalizeThemeValue(theme);
  document.documentElement.dataset.theme = state.theme;
  el.themeToggle.setAttribute("aria-pressed", state.theme === "dark" ? "true" : "false");
  el.themeToggle.title = state.theme === "dark" ? "ライトテーマに切り替える" : "ダークテーマに切り替える";
}

async function fetchThemeSetting() {
  const response = await fetch(getThemeSettingsUrl());
  if (!response.ok) {
    throw new Error(`テーマ取得に失敗しました (status: ${response.status})`);
  }
  const data = await response.json();
  return typeof data?.value === "string" ? data.value : "light";
}

async function saveThemeSetting(theme) {
  const response = await fetch(getThemeSettingsUrl(), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: theme }),
  });
  if (!response.ok) {
    throw new Error(`テーマ保存に失敗しました (status: ${response.status})`);
  }
  return response.json();
}

async function loadThemeSetting() {
  try {
    const theme = normalizeThemeValue(await fetchThemeSetting());
    applyTheme(theme);
  } catch (err) {
    console.error("[notes] テーマの読み込みに失敗しました:", err);
    applyTheme(document.documentElement.dataset.theme || "light");
  }
}

/* ---- data access layer ---- */

async function fetchList({ offset }) {
  const url = new URL(CONFIG.indexUrl);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("sort", state.sort);
  if (state.query) url.searchParams.set("q", state.query);
  if (state.activeTag) url.searchParams.set("tag", state.activeTag);

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`一覧の取得に失敗しました (status: ${response.status})`);
  }
  return response.json();
}

async function fetchEntry(id) {
  const response = await fetch(`${CONFIG.entryBaseUrl}${id}`);
  if (!response.ok) {
    throw new Error(`本文(${id})の取得に失敗しました (status: ${response.status})`);
  }
  return response.json();
}

async function createEntry(data) {
  return fetch(CONFIG.indexUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function updateEntry(id, data) {
  return fetch(`${CONFIG.entryBaseUrl}${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function togglePinnedEntry(id, pinned) {
  return fetch(`${CONFIG.entryBaseUrl}${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pinned }),
  });
}

async function removeEntry(id) {
  return fetch(`${CONFIG.entryBaseUrl}${id}`, {
    method: "DELETE",
  });
}

/* ---- formatting helpers ---- */

function formatDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}`;
}

function tagsToText(tags) {
  return Array.isArray(tags) ? tags.join(", ") : "";
}

function textToTags(text) {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function mergeKnownTags(items) {
  for (const item of items) {
    if (Array.isArray(item.tags)) {
      for (const tag of item.tags) {
        state.knownTags.add(tag);
      }
    }
  }
}

/* ---- error diagnostics ---- */

async function describeFailedResponse(response) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch (err) {
    bodyText = "(レスポンス本文を読み取れませんでした)";
  }
  return `status: ${response.status}, body: ${bodyText.slice(0, 500)}`;
}

/* ---- status messages (一覧側) ---- */

function showListStatus(message, tone) {
  el.listStatus.textContent = message;
  el.listStatus.hidden = false;
  if (tone) {
    el.listStatus.dataset.tone = tone;
  } else {
    delete el.listStatus.dataset.tone;
  }
}

function hideListStatus() {
  el.listStatus.hidden = true;
}

/* ---- status messages (本文側) ---- */

function showViewStatus(message, tone) {
  el.view.replaceChildren();
  el.viewStatus.textContent = message;
  el.viewStatus.hidden = false;
  if (tone) {
    el.viewStatus.dataset.tone = tone;
  } else {
    delete el.viewStatus.dataset.tone;
  }
}

function hideViewStatus() {
  el.viewStatus.hidden = true;
}

/* ---- rendering: タグフィルタチップ ---- */

function renderTagFilter() {
  const tags = [...state.knownTags].sort((a, b) => a.localeCompare(b, "ja"));

  if (tags.length === 0) {
    el.tagFilter.hidden = true;
    el.tagFilter.replaceChildren();
    return;
  }

  el.tagFilter.hidden = false;
  el.tagFilter.replaceChildren();

  for (const tag of tags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "tag-filter__chip";
    chip.classList.toggle("tag-filter__chip--active", tag === state.activeTag);
    chip.textContent = tag;
    chip.addEventListener("click", () => handleTagChipClick(tag));
    el.tagFilter.appendChild(chip);
  }
}

/* ---- rendering: 一覧 ---- */

function renderList() {
  el.list.replaceChildren();

  if (state.items.length === 0) {
    if (state.query.trim() || state.activeTag) {
      showListStatus("該当するメモが見つかりません。");
    } else {
      showListStatus("メモがまだありません。「+ 新規」から作成できます。");
    }
    updateLoadMoreVisibility();
    return;
  }
  hideListStatus();

  for (const item of state.items) {
    const li = document.createElement("li");
    li.className = "note-list__item";
    li.classList.toggle("note-list__item--active", item.id === state.selectedId);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-list__button";
    button.addEventListener("click", () => selectEntry(item.id));

    const title = document.createElement("p");
    title.className = "note-list__title";
    title.textContent = `${item.pinned ? "★ " : ""}${item.title || "(無題)"}`;

    const meta = document.createElement("div");
    meta.className = "note-list__meta";
    const date = document.createElement("time");
    date.className = "note-list__date";
    date.textContent = formatDate(item.date);
    meta.appendChild(date);

    button.appendChild(title);
    button.appendChild(meta);

    if (item.summary) {
      const summary = document.createElement("p");
      summary.className = "note-list__summary";
      summary.textContent = item.summary;
      button.appendChild(summary);
    }

    if (Array.isArray(item.tags) && item.tags.length > 0) {
      const tagList = document.createElement("div");
      tagList.className = "note-list__tags";
      for (const tag of item.tags) {
        const tagEl = document.createElement("span");
        tagEl.className = "note-list__tag";
        tagEl.textContent = tag;
        tagList.appendChild(tagEl);
      }
      button.appendChild(tagList);
    }

    li.appendChild(button);
    el.list.appendChild(li);
  }

  updateLoadMoreVisibility();
}

function parseInlineMarkdown(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    const token = match[0];
    if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      fragment.appendChild(strong);
    } else if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      fragment.appendChild(code);
    } else {
      fragment.appendChild(document.createTextNode(token));
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  return fragment;
}

function isMarkdownHeading(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line);
}

function isMarkdownUnorderedListItem(line) {
  return /^\s{0,3}[-*+]\s+/.test(line);
}

function isMarkdownOrderedListItem(line) {
  return /^\s{0,3}\d+\.\s+/.test(line);
}

function createParagraph(lines) {
  const paragraph = document.createElement("p");

  lines.forEach((line, index) => {
    if (index > 0) {
      paragraph.appendChild(document.createElement("br"));
    }
    paragraph.appendChild(parseInlineMarkdown(line.trimEnd()));
  });

  return paragraph;
}

function renderMarkdownContent(container, markdownText) {
  const text = typeof markdownText === "string" ? markdownText : "";
  const lines = text.split(/\r?\n/);
  const fragment = document.createDocumentFragment();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const headingLevel = headingMatch[1].length;
      const heading = document.createElement(`h${headingLevel}`);
      heading.appendChild(parseInlineMarkdown(headingMatch[2].trim()));
      fragment.appendChild(heading);
      index += 1;
      continue;
    }

    if (isMarkdownUnorderedListItem(line)) {
      const list = document.createElement("ul");
      while (index < lines.length && isMarkdownUnorderedListItem(lines[index])) {
        const item = document.createElement("li");
        item.appendChild(parseInlineMarkdown(lines[index].replace(/^\s{0,3}[-*+]\s+/, "").trimEnd()));
        list.appendChild(item);
        index += 1;
      }
      fragment.appendChild(list);
      continue;
    }

    if (isMarkdownOrderedListItem(line)) {
      const list = document.createElement("ol");
      while (index < lines.length && isMarkdownOrderedListItem(lines[index])) {
        const item = document.createElement("li");
        item.appendChild(parseInlineMarkdown(lines[index].replace(/^\s{0,3}\d+\.\s+/, "").trimEnd()));
        list.appendChild(item);
        index += 1;
      }
      fragment.appendChild(list);
      continue;
    }

    const paragraphLines = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isMarkdownHeading(lines[index]) &&
      !isMarkdownUnorderedListItem(lines[index]) &&
      !isMarkdownOrderedListItem(lines[index])
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }

    if (paragraphLines.length > 0) {
      fragment.appendChild(createParagraph(paragraphLines));
    }
  }

  container.replaceChildren(fragment);
}

function updateLoadMoreVisibility() {
  el.loadMoreButton.hidden = !state.hasMore;
  el.loadMoreButton.disabled = false;
}

function saveFormDraft(entryId, draft) {
  if (!draft.title && !draft.content && !draft.tags) {
    clearDraft(entryId);
    return;
  }
  writeDraft(entryId, draft);
}

/* ---- rendering: 本文(閲覧) ---- */

function renderEntry(entry) {
  hideViewStatus();
  el.view.replaceChildren();

  const actions = document.createElement("div");
  actions.className = "note-view__actions";

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "note-view__action-button";
  editButton.textContent = "編集";
  editButton.addEventListener("click", () => showEditForm(entry));

  const pinButton = document.createElement("button");
  pinButton.type = "button";
  pinButton.className = "note-view__action-button";
  pinButton.textContent = entry.pinned ? "固定済み" : "固定";
  pinButton.addEventListener("click", () => handlePinToggle(entry));

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "note-view__action-button note-view__action-button--danger";
  deleteButton.textContent = "削除";
  deleteButton.addEventListener("click", () => handleDeleteClick(entry.id));

  actions.appendChild(editButton);
  actions.appendChild(pinButton);
  actions.appendChild(deleteButton);

  const title = document.createElement("h2");
  title.className = "note-view__title";
  title.textContent = entry.title || "(無題)";

  const meta = document.createElement("div");
  meta.className = "note-view__meta";

  const date = document.createElement("time");
  date.className = "note-view__date";
  date.textContent = formatDate(entry.date);
  meta.appendChild(date);

  if (Array.isArray(entry.tags) && entry.tags.length > 0) {
    const tagList = document.createElement("div");
    tagList.className = "note-view__tags";
    for (const tag of entry.tags) {
      const tagEl = document.createElement("span");
      tagEl.className = "note-view__tag";
      tagEl.textContent = tag;
      tagList.appendChild(tagEl);
    }
    meta.appendChild(tagList);
  }

  const content = document.createElement("div");
  content.className = "note-view__content";
  renderMarkdownContent(content, entry.content || "");

  el.view.appendChild(actions);
  el.view.appendChild(title);
  el.view.appendChild(meta);
  el.view.appendChild(content);
}

/* ---- rendering: フォーム(新規作成 / 編集) ---- */

function renderForm(existingEntry) {
  hideViewStatus();
  el.view.replaceChildren();

  const isEdit = Boolean(existingEntry);
  const draft = readDraft(isEdit ? existingEntry.id : "new");

  const heading = document.createElement("h2");
  heading.className = "note-view__title";
  heading.textContent = isEdit ? "メモを編集" : "新規メモ";

  const form = document.createElement("form");
  form.className = "note-form";

  const titleLabel = document.createElement("label");
  titleLabel.className = "note-form__label";
  titleLabel.textContent = "タイトル(空欄可)";
  const titleInput = document.createElement("input");
  titleInput.className = "note-form__input";
  titleInput.type = "text";
  titleInput.value = draft ? draft.title || "" : isEdit ? existingEntry.title || "" : "";
  titleLabel.appendChild(titleInput);

  const contentLabel = document.createElement("label");
  contentLabel.className = "note-form__label";
  contentLabel.textContent = "本文";
  const contentInput = document.createElement("textarea");
  contentInput.className = "note-form__textarea";
  contentInput.required = true;
  contentInput.value = draft ? draft.content || "" : isEdit ? existingEntry.content || "" : "";
  contentLabel.appendChild(contentInput);

  const editorToolbar = document.createElement("div");
  editorToolbar.className = "note-form__toolbar";

  const markdownButtons = [
    { label: "太字", action: "bold" },
    { label: "見出し", action: "heading" },
    { label: "リスト", action: "list" },
    { label: "引用", action: "quote" },
  ];

  for (const item of markdownButtons) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-form__tool-button";
    button.textContent = item.label;
    button.addEventListener("click", () => {
      if (item.action === "bold") {
        insertMarkdownInline(contentInput, "**", "**");
      } else if (item.action === "heading") {
        insertMarkdownLinePrefix(contentInput, "# ");
      } else if (item.action === "list") {
        insertMarkdownLinePrefix(contentInput, "- ");
      } else if (item.action === "quote") {
        insertMarkdownLinePrefix(contentInput, "> ");
      }
      updatePreview();
      syncScrollByRatio(contentInput, previewBody);
    });
    editorToolbar.appendChild(button);
  }

  const tagsLabel = document.createElement("label");
  tagsLabel.className = "note-form__label";
  tagsLabel.textContent = "タグ(カンマ区切り、任意)";
  const tagsInput = document.createElement("input");
  tagsInput.className = "note-form__input";
  tagsInput.type = "text";
  tagsInput.setAttribute("list", "tag-suggestions");
  // "タイトル未設定" タグはサーバー側が自動管理するので、編集フォーム上は隠しておく
  // (ユーザーがタイトルを埋めれば保存時に自動で外れる)
  tagsInput.value = draft
    ? draft.tags || ""
    : isEdit
      ? tagsToText((existingEntry.tags || []).filter((t) => t !== UNTITLED_TAG))
      : "";
  tagsLabel.appendChild(tagsInput);

  const tagsHint = document.createElement("p");
  tagsHint.className = "note-form__hint";
  tagsHint.textContent = "過去のタグは候補から選べます。カンマ区切りで複数入力できます。";

  const tagSuggestions = document.createElement("datalist");
  tagSuggestions.id = "tag-suggestions";
  [...state.knownTags]
    .filter((tag) => tag !== UNTITLED_TAG)
    .sort((a, b) => a.localeCompare(b, "ja"))
    .forEach((tag) => {
      const option = document.createElement("option");
      option.value = tag;
      tagSuggestions.appendChild(option);
    });

  const feedback = document.createElement("p");
  feedback.className = "form-feedback";
  if (draft) {
    feedback.textContent = "下書きを復元しました。";
    feedback.dataset.tone = "info";
  }

  const previewDetails = document.createElement("details");
  previewDetails.className = "note-form__preview";
  previewDetails.open = !isCompactScreen();

  const previewSummary = document.createElement("summary");
  previewSummary.className = "note-form__preview-summary";
  previewSummary.textContent = "Markdownプレビュー";

  const previewBody = document.createElement("div");
  previewBody.className = "note-form__preview-body";

  let isSyncingScroll = false;
  let draftQueueArmed = false;

  const queueDraftSave = () => {
    draftQueueArmed = true;
    clearTimeout(draftSaveTimer);
    draftSaveTimer = setTimeout(() => {
      if (!draftQueueArmed) {
        return;
      }
      saveFormDraft(isEdit ? existingEntry.id : "new", {
        title: titleInput.value,
        content: contentInput.value,
        tags: tagsInput.value,
      });
      draftQueueArmed = false;
    }, DRAFT_SAVE_DELAY);
  };

  const updatePreview = () => {
    renderMarkdownContent(previewBody, contentInput.value);
    queueDraftSave();
  };

  const syncPreviewFromEditor = () => {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    syncScrollByRatio(contentInput, previewBody);
    isSyncingScroll = false;
  };

  const syncEditorFromPreview = () => {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    syncScrollByRatio(previewBody, contentInput);
    isSyncingScroll = false;
  };

  contentInput.addEventListener("input", updatePreview);
  contentInput.addEventListener("keydown", (event) => {
    const handled = handleTextareaTabIndent(event, contentInput);
    if (handled) {
      updatePreview();
      syncScrollByRatio(contentInput, previewBody);
    }
  });
  titleInput.addEventListener("input", queueDraftSave);
  tagsInput.addEventListener("input", queueDraftSave);
  contentInput.addEventListener("scroll", syncPreviewFromEditor, { passive: true });
  previewBody.addEventListener("scroll", syncEditorFromPreview, { passive: true });
  updatePreview();

  previewDetails.appendChild(previewSummary);
  previewDetails.appendChild(previewBody);

  const buttons = document.createElement("div");
  buttons.className = "note-form__buttons";

  const submitButton = document.createElement("button");
  submitButton.type = "submit";
  submitButton.className = "note-form__submit";
  submitButton.textContent = isEdit ? "更新を保存" : "保存";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.className = "note-form__cancel";
  cancelButton.textContent = "キャンセル";
  cancelButton.addEventListener("click", () => {
    if (isEdit) {
      selectEntry(existingEntry.id);
    } else {
      showEmptySelectionOrFirst();
    }
  });

  buttons.appendChild(submitButton);
  buttons.appendChild(cancelButton);

  form.appendChild(titleLabel);
  form.appendChild(editorToolbar);
  form.appendChild(contentLabel);
  form.appendChild(previewDetails);
  form.appendChild(tagsLabel);
  form.appendChild(tagsHint);
  form.appendChild(tagSuggestions);
  form.appendChild(feedback);
  form.appendChild(buttons);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    handleFormSubmit({
      isEdit,
      id: isEdit ? existingEntry.id : null,
      title: titleInput.value.trim(),
      content: contentInput.value,
      tags: textToTags(tagsInput.value),
      submitButton,
      feedback,
    });
  });

  window.setTimeout(() => {
    const focusTarget = draft && draft.title ? titleInput : contentInput;
    focusTarget.focus();
  }, 0);

  el.view.appendChild(heading);
  el.view.appendChild(form);
}

/* ---- interaction: 一覧の読み込み ---- */

async function loadList({ reset }) {
  const offset = reset ? 0 : state.items.length;

  try {
    const data = await fetchList({ offset });
    state.items = reset ? data.items : [...state.items, ...data.items];
    state.total = data.total;
    state.hasMore = data.hasMore;
    mergeKnownTags(data.items);
    renderTagFilter();
    renderList();
    return true;
  } catch (err) {
    console.error("[notes] 一覧の読み込みに失敗しました:", err);
    showListStatus("一覧を読み込めませんでした。時間をおいて再度お試しください。", "error");
    return false;
  }
}

async function handleLoadMore() {
  el.loadMoreButton.disabled = true;
  await loadList({ reset: false });
}

/* ---- interaction: 検索 / タグ絞り込み ---- */

function handleSearchInput(event) {
  const value = event.target.value;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    state.query = value;
    showListStatus("読み込み中…");
    loadList({ reset: true });
  }, 300);
}

function handleTagChipClick(tag) {
  state.activeTag = state.activeTag === tag ? null : tag;
  showListStatus("読み込み中…");
  loadList({ reset: true });
}

function handleSortChange(event) {
  state.sort = normalizeSortValue(event.target.value);
  saveStoredSort(state.sort);
  showListStatus("読み込み中…");
  loadList({ reset: true });
}

/* ---- interaction: 一覧選択 ---- */

async function selectEntry(id) {
  state.selectedId = id;
  renderList(); // 選択状態(強調表示)を反映するため再描画

  showViewStatus("読み込み中…");
  try {
    const entry = await fetchEntry(id);
    renderEntry(entry);
  } catch (err) {
    console.error("[notes] 本文の読み込みに失敗しました:", err);
    showViewStatus("本文を読み込めませんでした。時間をおいて再度お試しください。", "error");
  }
}

function showEmptySelectionOrFirst() {
  if (state.items.length > 0) {
    selectEntry(state.items[0].id);
  } else {
    state.selectedId = null;
    renderList();
    showViewStatus("メモがまだありません。「+ 新規」から作成できます。");
  }
}

/* ---- interaction: 新規作成 / 編集フォーム表示 ---- */

function showCreateForm() {
  state.selectedId = null;
  renderList();
  renderForm(null);
}

function showEditForm(entry) {
  renderForm(entry);
}

/* ---- interaction: フォーム送信 ---- */

async function handleFormSubmit({ isEdit, id, title, content, tags, submitButton, feedback }) {
  // タイトルは空欄可。本文だけは必須(サーバー側のcontent_requiredと対応)。
  if (!content) {
    feedback.textContent = "本文を入力してください。";
    feedback.dataset.tone = "error";
    return;
  }

  const configProblem = assertConfigIsSet();
  if (configProblem) {
    feedback.textContent = `設定エラー: ${configProblem}`;
    feedback.dataset.tone = "error";
    return;
  }

  submitButton.disabled = true;
  feedback.textContent = "保存中…";
  delete feedback.dataset.tone;

  try {
    const response = isEdit
      ? await updateEntry(id, { title, content, tags })
      : await createEntry({ title, content, tags });

    if (!response.ok) {
      const detail = await describeFailedResponse(response);
      console.error(`[notes] 保存失敗 (${isEdit ? "PUT" : "POST"}): ${detail}`);
      feedback.textContent = `保存に失敗しました (${detail})`;
      feedback.dataset.tone = "error";
      submitButton.disabled = false;
      return;
    }

    const savedEntry = await response.json();
    clearDraft(isEdit ? id : "new");
    feedback.textContent = "保存しました。";
    feedback.dataset.tone = "success";

    state.selectedId = savedEntry.id;
    await loadList({ reset: true });
    renderEntry(savedEntry);
  } catch (err) {
    console.error("[notes] 保存中に例外が発生しました:", err);
    feedback.textContent = `保存に失敗しました (${err && err.message ? err.message : "不明なエラー"})`;
    feedback.dataset.tone = "error";
    submitButton.disabled = false;
  }
}

async function handlePinToggle(entry) {
  const nextPinned = !Boolean(entry.pinned);

  try {
    const response = await togglePinnedEntry(entry.id, nextPinned);

    if (!response.ok) {
      const detail = await describeFailedResponse(response);
      console.error(`[notes] 固定切り替え失敗 (PATCH): ${detail}`);
      showViewStatus(`固定の切り替えに失敗しました (${detail})`, "error");
      return;
    }

    const savedEntry = await response.json();
    state.selectedId = savedEntry.id;
    await loadList({ reset: true });
    renderEntry(savedEntry);
  } catch (err) {
    console.error("[notes] 固定切り替え中に例外が発生しました:", err);
    showViewStatus(`固定の切り替えに失敗しました (${err && err.message ? err.message : "不明なエラー"})`, "error");
  }
}

function handleGlobalShortcut(event) {
  if (event.defaultPrevented || event.altKey) {
    return;
  }

  const target = event.target;
  const key = event.key.toLowerCase();
  const form = el.view.querySelector("form");

  if (key === "/" && !isTextEntryElement(target) && !form) {
    event.preventDefault();
    el.searchInput.focus();
    el.searchInput.select();
    return;
  }

  if (key === "n" && !isTextEntryElement(target) && !form) {
    event.preventDefault();
    state.selectedId = null;
    renderList();
    showCreateForm();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && key === "s" && form) {
    event.preventDefault();
    form.requestSubmit();
    return;
  }

  if (key === "escape" && form) {
    event.preventDefault();
    const cancelButton = form.querySelector(".note-form__cancel");
    if (cancelButton instanceof HTMLButtonElement) {
      cancelButton.click();
    }
  }
}

/* ---- interaction: 削除 ---- */

async function handleDeleteClick(id) {
  const confirmed = window.confirm("このメモを削除しますか？この操作は取り消せません。");
  if (!confirmed) return;

  showViewStatus("削除中…");
  try {
    const response = await removeEntry(id);

    if (!response.ok && response.status !== 204) {
      const detail = await describeFailedResponse(response);
      console.error(`[notes] 削除失敗 (DELETE): ${detail}`);
      showViewStatus(`削除に失敗しました (${detail})`, "error");
      return;
    }

    await loadList({ reset: true });
    showEmptySelectionOrFirst();
  } catch (err) {
    console.error("[notes] 削除中に例外が発生しました:", err);
    showViewStatus(
      `削除に失敗しました (${err && err.message ? err.message : "不明なエラー"})`,
      "error"
    );
  }
}

/* ---- theme ---- */

async function toggleTheme() {
  const nextTheme = state.theme === "dark" ? "light" : "dark";
  const previousTheme = state.theme;

  applyTheme(nextTheme);
  el.themeToggle.disabled = true;

  try {
    await saveThemeSetting(nextTheme);
  } catch (err) {
    console.error("[notes] テーマの保存に失敗しました:", err);
    applyTheme(previousTheme);
  } finally {
    el.themeToggle.disabled = false;
  }
}

/* ---- boot ---- */

async function init() {
  state.sort = getStoredSort();
  await loadThemeSetting();

  el.themeToggle.addEventListener("click", () => {
    void toggleTheme();
  });
  el.newNoteButton.addEventListener("click", showCreateForm);
  el.searchInput.addEventListener("input", handleSearchInput);
  el.sortSelect.value = state.sort;
  el.sortSelect.addEventListener("change", handleSortChange);
  el.loadMoreButton.addEventListener("click", handleLoadMore);
  document.addEventListener("keydown", handleGlobalShortcut);

  const configProblem = assertConfigIsSet();
  if (configProblem) {
    showListStatus(`設定エラー: ${configProblem}`, "error");
    showViewStatus("メモを選択してください。");
    return;
  }

  showListStatus("読み込み中…");
  showViewStatus("メモを選択してください。");

  const ok = await loadList({ reset: true });
  if (!ok) {
    showViewStatus("メモを選択してください。");
    return;
  }

  if (state.items.length === 0) {
    showViewStatus("メモがまだありません。「+ 新規」から作成できます。");
    return;
  }

  await selectEntry(state.items[0].id);
}

document.addEventListener("DOMContentLoaded", init);
