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

// アプリの状態はここだけで持つ（localStorageは使わない）
const state = {
  items: [],
  total: 0,
  hasMore: false,
  selectedId: null,
  query: "",
  activeTag: null,
  knownTags: new Set(), // タグチップ表示用。読み込んだ範囲から見えたタグを蓄積するだけの簡易実装
};

let searchDebounceTimer = null;

/* ---- DOM references ---- */

const el = {
  list: document.getElementById("note-list"),
  listStatus: document.getElementById("note-list-status"),
  view: document.getElementById("note-view"),
  viewStatus: document.getElementById("note-view-status"),
  themeToggle: document.getElementById("theme-toggle"),
  newNoteButton: document.getElementById("new-note-button"),
  searchInput: document.getElementById("search-input"),
  tagFilter: document.getElementById("tag-filter"),
  loadMoreButton: document.getElementById("load-more-button"),
};

/* ---- data access layer ---- */

async function fetchList({ offset }) {
  const url = new URL(CONFIG.indexUrl);
  url.searchParams.set("limit", String(PAGE_SIZE));
  url.searchParams.set("offset", String(offset));
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
    title.textContent = item.title || "(無題)";

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

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "note-view__action-button note-view__action-button--danger";
  deleteButton.textContent = "削除";
  deleteButton.addEventListener("click", () => handleDeleteClick(entry.id));

  actions.appendChild(editButton);
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
  titleInput.value = isEdit ? existingEntry.title || "" : "";
  titleLabel.appendChild(titleInput);

  const contentLabel = document.createElement("label");
  contentLabel.className = "note-form__label";
  contentLabel.textContent = "本文";
  const contentInput = document.createElement("textarea");
  contentInput.className = "note-form__textarea";
  contentInput.required = true;
  contentInput.value = isEdit ? existingEntry.content || "" : "";
  contentLabel.appendChild(contentInput);

  const tagsLabel = document.createElement("label");
  tagsLabel.className = "note-form__label";
  tagsLabel.textContent = "タグ(カンマ区切り、任意)";
  const tagsInput = document.createElement("input");
  tagsInput.className = "note-form__input";
  tagsInput.type = "text";
  // "タイトル未設定" タグはサーバー側が自動管理するので、編集フォーム上は隠しておく
  // (ユーザーがタイトルを埋めれば保存時に自動で外れる)
  tagsInput.value = isEdit ? tagsToText((existingEntry.tags || []).filter((t) => t !== UNTITLED_TAG)) : "";
  tagsLabel.appendChild(tagsInput);

  const feedback = document.createElement("p");
  feedback.className = "form-feedback";

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
  form.appendChild(contentLabel);
  form.appendChild(tagsLabel);
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

function toggleTheme() {
  const current = document.body.dataset.theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = current === "dark" ? "light" : "dark";
}

/* ---- boot ---- */

async function init() {
  el.themeToggle.addEventListener("click", toggleTheme);
  el.newNoteButton.addEventListener("click", showCreateForm);
  el.searchInput.addEventListener("input", handleSearchInput);
  el.loadMoreButton.addEventListener("click", handleLoadMore);

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
