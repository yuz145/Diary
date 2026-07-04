/**
 * notes-api (Cloudflare Workers)
 *
 * R2への書き込みはここ経由のみに限定する。フロントから直接PUTはさせない。
 *
 * Endpoints:
 *   GET    /api/notes        -> index.json を返す
 *   GET    /api/notes/:id    -> entries/:id.json を返す
 *   POST   /api/notes        -> 新規作成 (auth必須)
 *   PUT    /api/notes/:id    -> 更新       (auth必須)
 *   DELETE /api/notes/:id    -> 削除       (auth必須)
 */

const INDEX_KEY = "notes/index.json";
const entryKey = (id) => `notes/entries/${id}.json`;

/* ---------------------------------------------------------------------- */
/* CORS                                                                    */
/* ---------------------------------------------------------------------- */

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Auth-Token",
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

/* ---------------------------------------------------------------------- */
/* 認証 (合言葉方式) — 将来 JWT 等に強化する場合はこの関数だけ差し替える   */
/* ---------------------------------------------------------------------- */

function isAuthorized(request, env) {
  const token = request.headers.get("X-Auth-Token");
  if (!token || !env.AUTH_TOKEN) return false;
  return token === env.AUTH_TOKEN;
}

/* ---------------------------------------------------------------------- */
/* R2 アクセス層                                                          */
/* ---------------------------------------------------------------------- */

async function readJson(bucket, key) {
  const object = await bucket.get(key);
  if (!object) return null;
  const text = await object.text();
  return JSON.parse(text);
}

async function writeJson(bucket, key, value) {
  await bucket.put(key, JSON.stringify(value), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function getIndex(env) {
  const items = await readJson(env.NOTES_BUCKET, INDEX_KEY);
  return items || [];
}

async function putIndex(env, items) {
  await writeJson(env.NOTES_BUCKET, INDEX_KEY, items);
}

async function getEntry(env, id) {
  return readJson(env.NOTES_BUCKET, entryKey(id));
}

async function putEntry(env, id, entry) {
  await writeJson(env.NOTES_BUCKET, entryKey(id), entry);
}

async function deleteEntry(env, id) {
  await env.NOTES_BUCKET.delete(entryKey(id));
}

/* ---------------------------------------------------------------------- */
/* ID採番: YYYY-MM-DD-NNN (同日連番, 3桁ゼロ埋め)                          */
/* ---------------------------------------------------------------------- */

function generateId(items, now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePrefix = `${y}-${m}-${d}`;

  const todaysSeqs = items
    .map((item) => item.id)
    .filter((id) => typeof id === "string" && id.startsWith(datePrefix))
    .map((id) => Number(id.slice(datePrefix.length + 1)))
    .filter((n) => Number.isInteger(n));

  const nextSeq = todaysSeqs.length > 0 ? Math.max(...todaysSeqs) + 1 : 1;
  return `${datePrefix}-${String(nextSeq).padStart(3, "0")}`;
}

/* ---------------------------------------------------------------------- */
/* index.json 用メタデータへの変換                                        */
/* ---------------------------------------------------------------------- */

function toIndexMeta(entry) {
  return {
    id: entry.id,
    title: entry.title,
    date: entry.date,
    summary: (entry.content || "").slice(0, 60),
    tags: entry.tags || [],
  };
}

/* ---------------------------------------------------------------------- */
/* ハンドラ                                                                */
/* ---------------------------------------------------------------------- */

async function handleGetIndex(env) {
  const items = await getIndex(env);
  return jsonResponse(items, 200, env);
}

async function handleGetEntry(env, id) {
  const entry = await getEntry(env, id);
  if (!entry) {
    return jsonResponse({ error: "not_found" }, 404, env);
  }
  return jsonResponse(entry, 200, env);
}

async function handleCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "invalid_json" }, 400, env);
  }

  if (!body || typeof body.title !== "string" || typeof body.content !== "string") {
    return jsonResponse({ error: "title_and_content_required" }, 400, env);
  }

  const items = await getIndex(env);
  const now = new Date().toISOString();
  const id = generateId(items, new Date());

  const entry = {
    id,
    title: body.title,
    date: now,
    updatedAt: now,
    tags: Array.isArray(body.tags) ? body.tags : [],
    content: body.content,
    format: "plain",
  };

  try {
    await putEntry(env, id, entry);
  } catch (err) {
    return jsonResponse({ error: "entry_write_failed" }, 500, env);
  }

  try {
    const nextItems = [...items, toIndexMeta(entry)];
    await putIndex(env, nextItems);
  } catch (err) {
    // index更新に失敗した場合、本体だけが孤立して残るのを避けるため削除する
    await deleteEntry(env, id).catch(() => {});
    return jsonResponse({ error: "index_write_failed" }, 500, env);
  }

  return jsonResponse(entry, 201, env);
}

async function handleUpdate(request, env, id) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonResponse({ error: "invalid_json" }, 400, env);
  }

  if (!body || typeof body.title !== "string" || typeof body.content !== "string") {
    return jsonResponse({ error: "title_and_content_required" }, 400, env);
  }

  const existing = await getEntry(env, id);
  if (!existing) {
    return jsonResponse({ error: "not_found" }, 404, env);
  }

  const updatedEntry = {
    ...existing,
    title: body.title,
    content: body.content,
    tags: Array.isArray(body.tags) ? body.tags : existing.tags || [],
    updatedAt: new Date().toISOString(),
  };

  try {
    await putEntry(env, id, updatedEntry);
  } catch (err) {
    return jsonResponse({ error: "entry_write_failed" }, 500, env);
  }

  try {
    const items = await getIndex(env);
    const nextItems = items.map((item) =>
      item.id === id ? toIndexMeta(updatedEntry) : item
    );
    await putIndex(env, nextItems);
  } catch (err) {
    return jsonResponse({ error: "index_write_failed" }, 500, env);
  }

  return jsonResponse(updatedEntry, 200, env);
}

async function handleDelete(env, id) {
  const existing = await getEntry(env, id);
  if (!existing) {
    return jsonResponse({ error: "not_found" }, 404, env);
  }

  try {
    await deleteEntry(env, id);
  } catch (err) {
    return jsonResponse({ error: "entry_delete_failed" }, 500, env);
  }

  try {
    const items = await getIndex(env);
    const nextItems = items.filter((item) => item.id !== id);
    await putIndex(env, nextItems);
  } catch (err) {
    return jsonResponse({ error: "index_write_failed" }, 500, env);
  }

  return emptyResponse(204, env);
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
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "notes", ":id"?]

    if (parts[0] !== "api" || parts[1] !== "notes") {
      return jsonResponse({ error: "not_found" }, 404, env);
    }

    const id = parts[2];

    // 参照系(GET)は認証不要、更新系は認証必須
    if (request.method !== "GET" && !isAuthorized(request, env)) {
      return jsonResponse({ error: "unauthorized" }, 401, env);
    }

    try {
      if (request.method === "GET" && !id) {
        return await handleGetIndex(env);
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
      if (request.method === "DELETE" && id) {
        return await handleDelete(env, id);
      }
    } catch (err) {
      return jsonResponse({ error: "internal_error" }, 500, env);
    }

    return jsonResponse({ error: "not_found" }, 404, env);
  },
};