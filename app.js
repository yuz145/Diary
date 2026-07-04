"use strict";

/* ==========================================================================
   notes — app.js
   Phase 2: R2への読み書きは全て Cloudflare Workers 経由。
   フロントから直接R2へPUTすることはない。
   ========================================================================== */

// Workers デプロイ後に発行されるURLに置き換える
const CONFIG = {
  indexUrl: "https://<R2_PUBLIC_BASE>/notes/index.json",
  entryBaseUrl: "https://notes-api.<subdomain>.workers.dev/api/notes/",
};

// アプリの状態はここだけで持つ（localStorageは使わない）
const state = {
  items: [],
  selectedId: null,
  authToken: null, // メモリ上のみ。リロードで消えてよい。
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

/* ---- 認証 ---- */

function ensureAuthToken() {
  if (state.authToken) return state.authToken;
  const input = window.prompt("合言葉(トークン)を入力してください");
  if (!input) return null;
  state.authToken = input;
  return state.authToken;
}

function forgetAuthToken() {
  state.authToken = null;
}

async function authorizedFetch(url, options) {
  const token = ensureAuthToken();
  if (!token) {
    throw new Error("auth_cancelled");
  }
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Auth-Token": token,
    },
  });
  if (response.status === 401) {
    // トークンが違う場合は覚えているものを捨てて次回また入力させる
    forgetAuthToken();
  }
  return response;
}

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
  return authorizedFetch(CONFIG.indexUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function updateEntry(id, data) {
  return authorizedFetch(`${CONFIG.entryBaseUrl}${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

async function removeEntry(id) {
  return authorizedFetch(`${CONFIG.entryBaseUrl}${id}`, {
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

  submitButton.disabled = true;
  feedback.textContent = "保存中…";
  delete feedback.dataset.tone;

  try {
    const response = isEdit
      ? await updateEntry(id, { title, content, tags })
      : await createEntry({ title, content, tags });

    if (response.status === 401) {
      feedback.textContent = "合言葉が正しくありません。もう一度お試しください。";
      feedback.dataset.tone = "error";
      submitButton.disabled = false;
      return;
    }

    if (!response.ok) {
      feedback.textContent = "保存に失敗しました。時間をおいて再度お試しください。";
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
    if (err && err.message === "auth_cancelled") {
      feedback.textContent = "合言葉の入力がキャンセルされました。";
    } else {
      feedback.textContent = "保存に失敗しました。時間をおいて再度お試しください。";
    }
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

    if (response.status === 401) {
      showViewStatus("合言葉が正しくありません。もう一度お試しください。", "error");
      return;
    }
    if (!response.ok && response.status !== 204) {
      showViewStatus("削除に失敗しました。時間をおいて再度お試しください。", "error");
      return;
    }

    const items = await fetchIndex();
    state.items = sortByDateDesc(items);
    showEmptySelectionOrFirst();
  } catch (err) {
    if (err && err.message === "auth_cancelled") {
      showViewStatus("合言葉の入力がキャンセルされました。", "error");
    } else {
      showViewStatus("削除に失敗しました。時間をおいて再度お試しください。", "error");
    }
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
    showListStatus("一覧を読み込めませんでした。時間をおいて再度お試しください。", "error");
    showViewStatus("メモを選択してください。");
  }
}

document.addEventListener("DOMContentLoaded", init);