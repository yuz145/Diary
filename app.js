"use strict";

/* ==========================================================================
   notes — app.js
   Phase 1: Cloudflare R2 から index.json / entries/*.json を読むだけの
   最小構成。将来 Workers API に差し替える前提で fetch先はここに集約する。
   ========================================================================== */

// 今は R2 を直接読む。将来はここを '/api/notes' 系に置き換える。
const CONFIG = {
  indexUrl: "https://pub-e5e3bb4f567c42cabe57034c606e7b3b.r2.dev",
  entryBaseUrl: "https://<R2_PUBLIC_BASE>/notes/entries/",
};

// アプリの状態はここだけで持つ（localStorageは使わない）
const state = {
  items: [],
  selectedId: null,
};

// fetch失敗時にUI確認したい場合はここのコメントを外す
// const FALLBACK_INDEX_SAMPLE = [
//   {
//     id: "2026-07-04-001",
//     title: "買い物メモ",
//     date: "2026-07-04T13:30:00+09:00",
//     summary: "牛乳とSDカード",
//     tags: ["daily", "memo"],
//   },
// ];
// const FALLBACK_ENTRY_SAMPLE = {
//   id: "2026-07-04-001",
//   title: "買い物メモ",
//   date: "2026-07-04T13:30:00+09:00",
//   tags: ["daily", "memo"],
//   content: "牛乳\nSDカード\n電池",
//   format: "plain",
// };

/* ---- DOM references ---- */

const el = {
  list: document.getElementById("note-list"),
  listStatus: document.getElementById("note-list-status"),
  view: document.getElementById("note-view"),
  viewStatus: document.getElementById("note-view-status"),
  themeToggle: document.getElementById("theme-toggle"),
};

/* ---- data access layer ---- */

async function fetchIndex() {
  const response = await fetch(CONFIG.indexUrl);
  if (!response.ok) {
    throw new Error(`index.json の取得に失敗しました (status: ${response.status})`);
  }
  return response.json();
}

async function fetchEntry(id) {
  const response = await fetch(`${CONFIG.entryBaseUrl}${id}.json`);
  if (!response.ok) {
    throw new Error(`本文(${id})の取得に失敗しました (status: ${response.status})`);
  }
  return response.json();
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

/* ---- status messages ---- */

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

/* ---- rendering ---- */

function renderList(items) {
  el.list.replaceChildren();

  if (items.length === 0) {
    showListStatus("メモがまだありません。");
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

function renderEntry(entry) {
  hideViewStatus();
  el.view.replaceChildren();

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
  // format は将来 "markdown" 等に拡張予定。今は plain のみ想定。
  content.textContent = entry.content || "";

  el.view.appendChild(title);
  el.view.appendChild(meta);
  el.view.appendChild(content);
}

/* ---- interaction ---- */

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

function toggleTheme() {
  const current = document.body.dataset.theme === "dark" ? "dark" : "light";
  document.body.dataset.theme = current === "dark" ? "light" : "dark";
}

/* ---- boot ---- */

async function init() {
  el.themeToggle.addEventListener("click", toggleTheme);

  showListStatus("読み込み中…");
  showViewStatus("メモを選択してください。");

  try {
    const items = await fetchIndex();
    state.items = sortByDateDesc(items);

    if (state.items.length === 0) {
      renderList(state.items);
      showViewStatus("メモがまだありません。");
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
