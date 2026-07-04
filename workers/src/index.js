/**
 * notes-api (Cloudflare Workers)
 *
 * D1 = 本文・メタデータ本体。R2 = 画像のみ。
 * アクセス制御はCloudflare Access側で行うため、ここには認証ロジックを持たせない。
 *
 * Endpoints:
 *   GET    /api/notes?limit=&offset=&q=&tag=&sort= -> 一覧(検索/タグ絞り込み/並び替え/ページング)
 *   GET    /api/notes/:id                     -> 詳細(本文全文・画像キー含む)
 *   POST   /api/notes                          -> 新規作成
 *   PUT    /api/notes/:id                      -> 更新
 *   PATCH  /api/notes/:id                      -> pin切り替え
 *   DELETE /api/notes/:id                      -> 削除
 *   GET    /api/images/:key                    -> R2から画像を返す(遅延読み込み用)
 */

const UNTITLED_TAG = "タイトル未設定";
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
const DEFAULT_THEME = "light";
const DEFAULT_SORT = "pinned";

const SORT_SQL = {
  pinned: "pinned DESC, updated_at DESC, date DESC, id DESC",
  updated: "updated_at DESC, date DESC, id DESC",
  created: "date DESC, id DESC",
  title: "COALESCE(title, '') COLLATE NOCASE ASC, date DESC, id DESC",
};

/* ---------------------------------------------------------------------- */
/* CORS                                                                    */
/* ---------------------------------------------------------------------- */

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(env),
    },
  });
}

function emptyResponse(status, env) {
  return new Response(null, { status, headers: corsHeaders(env) });
}

function getThemeValueUrl(url) {
  const themeUrl = new URL(url.toString());
  themeUrl.pathname = "/api/settings/theme";
  themeUrl.search = "";
  return themeUrl;
}

/* ---------------------------------------------------------------------- */
/* タイトル未入力ルール — POST/PUT どちらからも呼ぶ共通関数              */
/* ---------------------------------------------------------------------- */

function normalizeTitleAndTags(rawTitle, rawTags) {
  const title = typeof rawTitle === "string" ? rawTitle.trim() : "";
  const tags = Array.isArray(rawTags) ? rawTags.filter((t) => typeof t === "string" && t.trim()) : [];

  if (!title) {
    const withUntitledTag = tags.includes(UNTITLED_TAG) ? tags : [...tags, UNTITLED_TAG];
    return { title: null, tags: withUntitledTag };
  }

  return { title, tags: tags.filter((t) => t !== UNTITLED_TAG) };
}

/* ---------------------------------------------------------------------- */
/* tags <-> DB 文字列 変換                                                */
/* ---------------------------------------------------------------------- */

function tagsToDb(tags) {
  return Array.isArray(tags) ? tags.join(",") : "";
}

function tagsFromDb(text) {
  return text ? text.split(",").filter((t) => t.length > 0) : [];
}

/* ---------------------------------------------------------------------- */
/* 行 -> レスポンス形式 変換                                              */
/* ---------------------------------------------------------------------- */

function rowToListItem(row) {
  return {
    id: row.id,
    title: row.title,
    date: row.date,
    updatedAt: row.updated_at,
    pinned: Number(row.pinned || 0) === 1,
    tags: tagsFromDb(row.tags),
    summary: (row.content || "").slice(0, 100),
  };
}

function rowToDetail(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    date: row.date,
    updatedAt: row.updated_at,
    pinned: Number(row.pinned || 0) === 1,
    tags: tagsFromDb(row.tags),
    format: "plain",
    imageKeys: JSON.parse(row.image_keys || "[]"),
  };
}

async function getSettingValue(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
  return row ? row.value : null;
}

async function setSettingValue(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(key, value)
    .run();
}

async function handleGetTheme(env) {
  const storedValue = await getSettingValue(env, "theme");
  const value = storedValue || DEFAULT_THEME;
  return jsonResponse({ key: "theme", value }, 200, env);
}

async function handlePutTheme(request, env) {
  let value = null;

  const contentType = request.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    let body;
    try {
      body = await request.json();
    } catch (err) {
      return jsonResponse({ error: "invalid_json" }, 400, env);
    }
    value = typeof body?.value === "string" ? body.value.trim() : null;
  } else {
    value = (await request.text()).trim();
  }

  if (!value) {
    return jsonResponse({ error: "value_required" }, 400, env);
  }

  await setSettingValue(env, "theme", value);
  return jsonResponse({ key: "theme", value }, 200, env);
}

/* ---------------------------------------------------------------------- */
/* ID採番: YYYY-MM-DD-NNN (同日連番, 3桁ゼロ埋め)                          */
/* ---------------------------------------------------------------------- */

async function generateId(env, now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePrefix = `${y}-${m}-${d}`;

  const { results } = await env.DB.prepare("SELECT id FROM notes WHERE id LIKE ?")
    .bind(`${datePrefix}-%`)
    .all();

  const seqs = (results || [])
    .map((row) => Number(row.id.slice(datePrefix.length + 1)))
    .filter((n) => Number.isInteger(n));

  const nextSeq = seqs.length > 0 ? Math.max(...seqs) + 1 : 1;
  return `${datePrefix}-${String(nextSeq).padStart(3, "0")}`;
}

/* ---------------------------------------------------------------------- */
/* 画像 (R2)                                                              */
/* ---------------------------------------------------------------------- */

const EXTENSION_BY_CONTENT_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function uploadImages(env, noteId, images, startIndex) {
  const uploadedKeys = [];
  let index = startIndex;
  for (const image of images) {
    if (!image || typeof image.data !== "string") continue;
    const contentType = image.contentType || "application/octet-stream";
    const extension = EXTENSION_BY_CONTENT_TYPE[contentType] || "bin";
    const key = `images/${noteId}-${index}.${extension}`;
    const bytes = base64ToBytes(image.data);
    await env.IMAGES_BUCKET.put(key, bytes, { httpMetadata: { contentType } });
    uploadedKeys.push(key);
    index += 1;
  }
  return uploadedKeys;
}

async function deleteImages(env, keys) {
  for (const key of keys) {
    try {
      await env.IMAGES_BUCKET.delete(key);
    } catch (err) {
      // 個別の削除失敗はログの必要はあるが、他の後始末は止めない
    }
  }
}

/* ---------------------------------------------------------------------- */
/* ハンドラ: 一覧 (検索・タグ絞り込み・ページング)                        */
/* ---------------------------------------------------------------------- */

async function handleList(url, env) {
  const params = url.searchParams;
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(params.get("limit") || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT));
  const offset = Math.max(0, parseInt(params.get("offset") || "0", 10) || 0);
  const q = (params.get("q") || "").trim();
  const tag = (params.get("tag") || "").trim();
  const sort = SORT_SQL[params.get("sort") || DEFAULT_SORT] || SORT_SQL[DEFAULT_SORT];

  const conditions = [];
  const bindings = [];

  if (q) {
    conditions.push("(title LIKE ? OR content LIKE ?)");
    bindings.push(`%${q}%`, `%${q}%`);
  }
  if (tag) {
    conditions.push("(',' || tags || ',') LIKE ?");
    bindings.push(`%,${tag},%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const countStmt = env.DB.prepare(`SELECT COUNT(*) as count FROM notes ${whereClause}`).bind(...bindings);
  const countResult = await countStmt.first();
  const total = countResult ? countResult.count : 0;

  const listStmt = env.DB
    .prepare(
      `SELECT id, title, date, updated_at, tags, content, pinned FROM notes ${whereClause} ORDER BY ${sort} LIMIT ? OFFSET ?`
    )
    .bind(...bindings, limit, offset);
  const { results } = await listStmt.all();

  const items = (results || []).map(rowToListItem);

  return jsonResponse(
    {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    },
    200,
    env
  );
}

async function handleGetEntry(env, id) {
  const row = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
  if (!row) {
    return jsonResponse({ error: "not_found" }, 404, env);
  }
  return jsonResponse(rowToDetail(row), 200, env);
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "invalid_json" }, 400, env);
  }

  if (!body || typeof body.content !== "string") {
    return jsonResponse({ error: "content_required" }, 400, env);
  }

  const { title, tags } = normalizeTitleAndTags(body.title, body.tags);
  const id = await generateId(env);
  const now = new Date().toISOString();

  let imageKeys = [];
  if (Array.isArray(body.images) && body.images.length > 0) {
    try {
      imageKeys = await uploadImages(env, id, body.images, 1);
    } catch (err) {
      return jsonResponse({ error: "image_upload_failed" }, 500, env);
    }
  }

  try {
    await env.DB.prepare(
      "INSERT INTO notes (id, title, content, date, updated_at, tags, image_keys, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, title, body.content, now, now, tagsToDb(tags), JSON.stringify(imageKeys), typeof body.pinned === "boolean" ? (body.pinned ? 1 : 0) : 0)
      .run();
  } catch (err) {
    // D1書き込みに失敗した場合、先にアップロードした画像が孤立するのを避けて削除する
    await deleteImages(env, imageKeys);
    return jsonResponse({ error: "db_write_failed" }, 500, env);
  }

  const row = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
  return jsonResponse(rowToDetail(row), 201, env);
}

async function handleUpdate(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "invalid_json" }, 400, env);
  }

  if (!body || (typeof body.content !== "string" && typeof body.pinned !== "boolean")) {
    return jsonResponse({ error: "content_or_pinned_required" }, 400, env);
  }

  const existing = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
  if (!existing) {
    return jsonResponse({ error: "not_found" }, 404, env);
  }

  if (typeof body.content !== "string") {
    const updatedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE notes SET pinned = ?, updated_at = ? WHERE id = ?")
      .bind(body.pinned ? 1 : 0, updatedAt, id)
      .run();

    const row = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
    return jsonResponse(rowToDetail(row), 200, env);
  }

  const { title, tags } = normalizeTitleAndTags(body.title, body.tags);
  const pinned = typeof body.pinned === "boolean" ? (body.pinned ? 1 : 0) : Number(existing.pinned || 0);
  let imageKeys = JSON.parse(existing.image_keys || "[]");

  const removeKeys = Array.isArray(body.removeImageKeys) ? body.removeImageKeys : [];
  if (removeKeys.length > 0) {
    await deleteImages(env, removeKeys);
    imageKeys = imageKeys.filter((key) => !removeKeys.includes(key));
  }

  let newlyUploadedKeys = [];
  if (Array.isArray(body.images) && body.images.length > 0) {
    try {
      newlyUploadedKeys = await uploadImages(env, id, body.images, imageKeys.length + 1);
      imageKeys = [...imageKeys, ...newlyUploadedKeys];
    } catch (err) {
      return jsonResponse({ error: "image_upload_failed" }, 500, env);
    }
  }

  const updatedAt = new Date().toISOString();

  try {
    await env.DB.prepare(
      "UPDATE notes SET title = ?, content = ?, tags = ?, image_keys = ?, pinned = ?, updated_at = ? WHERE id = ?"
    )
      .bind(title, body.content, tagsToDb(tags), JSON.stringify(imageKeys), pinned, updatedAt, id)
      .run();
  } catch (err) {
    // 新規追加分の画像だけはロールバック可能。削除済み画像の復元はできないため、
    // ここに来ることは基本的に避けたい(D1書き込み失敗は稀なケース)。
    await deleteImages(env, newlyUploadedKeys);
    return jsonResponse({ error: "db_write_failed" }, 500, env);
  }

  const row = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
  return jsonResponse(rowToDetail(row), 200, env);
}

async function handleDelete(env, id) {
  const existing = await env.DB.prepare("SELECT * FROM notes WHERE id = ?").bind(id).first();
  if (!existing) {
    return jsonResponse({ error: "not_found" }, 404, env);
  }

  const imageKeys = JSON.parse(existing.image_keys || "[]");
  await deleteImages(env, imageKeys);

  try {
    await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();
  } catch (err) {
    return jsonResponse({ error: "db_delete_failed" }, 500, env);
  }

  return emptyResponse(204, env);
}

async function handleGetImage(env, key) {
  const object = await env.IMAGES_BUCKET.get(key);
  if (!object) {
    return jsonResponse({ error: "not_found" }, 404, env);
  }
  const headers = new Headers(corsHeaders(env));
  headers.set("Content-Type", object.httpMetadata?.contentType || "application/octet-stream");
  return new Response(object.body, { status: 200, headers });
}

/* ---------------------------------------------------------------------- */
/* ルーティング                                                            */
/* ---------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return emptyResponse(204, env);
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/settings/theme") {
      try {
        if (request.method === "GET") {
          return await handleGetTheme(env);
        }
        if (request.method === "PUT") {
          return await handlePutTheme(request, env);
        }
      } catch (err) {
        return jsonResponse({ error: "internal_error" }, 500, env);
      }
      return jsonResponse({ error: "method_not_allowed" }, 405, env);
    }

    if (url.pathname.startsWith("/api/images/")) {
      if (request.method !== "GET") {
        return jsonResponse({ error: "method_not_allowed" }, 405, env);
      }
      const key = decodeURIComponent(url.pathname.slice("/api/images/".length));
      try {
        return await handleGetImage(env, key);
      } catch (err) {
        return jsonResponse({ error: "internal_error" }, 500, env);
      }
    }

    const parts = url.pathname.split("/").filter(Boolean); // ["api", "notes", ":id"?]
    if (parts[0] !== "api" || parts[1] !== "notes") {
      return jsonResponse({ error: "not_found" }, 404, env);
    }

    const id = parts[2];

    try {
      if (request.method === "GET" && !id) {
        return await handleList(url, env);
      }
      if (request.method === "GET" && id) {
        return await handleGetEntry(env, id);
      }
      if (request.method === "POST" && !id) {
        return await handleCreate(request, env);
      }
      if (request.method === "PUT" && id) {
        return await handleUpdate(request, env, id);
      }
      if (request.method === "PATCH" && id) {
        return await handleUpdate(request, env, id);
      }
      if (request.method === "DELETE" && id) {
        return await handleDelete(env, id);
      }
    } catch (err) {
      return jsonResponse({ error: "internal_error" }, 500, env);
    }

    return jsonResponse({ error: "not_found" }, 404, env);
  },
};
