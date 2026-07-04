"use strict";

/* ==========================================================================
   notes — config.js
   ここだけ書き換えればOK。app.js側は一切触らなくてよい。
   ========================================================================== */

const CONFIG = {
  // wrangler deploy で発行されたWorkersのURLに置き換える
  // 例: https://oyuzen.your-subdomain.workers.dev/api/notes
  indexUrl: "https://notes-api.yuz145.workers.dev/api/notes",
  entryBaseUrl: "https://notes-api.yuz145.workers.dev/api/notes/",
};
