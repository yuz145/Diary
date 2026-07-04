"use strict";

/* ==========================================================================
   notes — app.js
   Phase 2: R2への読み書きは全て Cloudflare Workers 経由。
   フロントから直接R2へPUTすることはない。
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

// アプリの状態はここだけで持つ（localStorageは使わない）
const state = {
  items: [],
  selectedId: null,
};

/* ---- DOM references ---- */

const el = {
  list: document.getElementById("note-list"),
  listStatus: document.getElementById("note-list-status"),
  view: document.getElementById("note-view"),
  viewStatus: document.getElementById("note-view-status"),
  themeToggle: document.getElementById("theme-toggle"),
  newNoteButton: document.getElementById("new-note-button"),
};

/* ---- data access layer ---- */

async function fetchIndex() {
  const response = await fetch(CONFIG.indexUrl);
  if (!response.ok) {
    throw new Error(`index の取得に失敗しました (status: ${response.status})`);
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

function sortByDateDesc(items) {
  return [...items].sort((a, b) => new Date(b.date) - new Date(a.date));
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

/* ---- rendering: 一覧 ---- */

function renderList(items) {
  el.list.replaceChildren();

  if (items.length === 0) {
    showListStatus("メモがまだありません。「+ 新規」から作成できます。");
    return;
  }
  hideListStatus();

  for (const item of items) {
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
  content.textContent = entry.content || "";

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
  titleLabel.textContent = "タイトル";
  const titleInput = document.createElement("input");
  titleInput.className = "note-form__input";
  titleInput.type = "text";
  titleInput.required = true;
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
  tagsInput.value = isEdit ? tagsToText(existingEntry.tags) : "";
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

/* ---- interaction: 一覧選択 ---- */

async function selectEntry(id) {
  state.selectedId = id;
  renderList(state.items); // 選択状態(強調表示)を反映するため再描画

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
    renderList(state.items);
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
  if (!title || !content) {
    feedback.textContent = "タイトルと本文を入力してください。";
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

    const items = await fetchIndex();
    state.items = sortByDateDesc(items);
    state.selectedId = savedEntry.id;
    renderList(state.items);
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

    const items = await fetchIndex();
    state.items = sortByDateDesc(items);
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

  const configProblem = assertConfigIsSet();
  if (configProblem) {
    showListStatus(`設定エラー: ${configProblem}`, "error");
    showViewStatus("メモを選択してください。");
    return;
  }

  showListStatus("読み込み中…");
  showViewStatus("メモを選択してください。");

  try {
    const items = await fetchIndex();
    state.items = sortByDateDesc(items);

    if (state.items.length === 0) {
      renderList(state.items);
      showViewStatus("メモがまだありません。「+ 新規」から作成できます。");
      return;
    }

    renderList(state.items);
    await selectEntry(state.items[0].id);
  } catch (err) {
    console.error("[notes] 一覧の読み込みに失敗しました:", err);
    showListStatus("一覧を読み込めませんでした。時間をおいて再度お試しください。", "error");
    showViewStatus("メモを選択してください。");
  }
}

document.addEventListener("DOMContentLoaded", init);