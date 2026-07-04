"use strict";

/* ==========================================================================
   notes — config.js
   ここだけ書き換えればOK。app.js側は一切触らなくてよい。
   ========================================================================== */

const CONFIG = {
  // wrangler deploy で発行されたWorkersのURLに置き換える
  // 例: https://oyuzen.your-subdomain.workers.dev/api/notes
  indexUrl: "https://pub-e5e3bb4f567c42cabe57034c606e7b3b.r2.dev",
  entryBaseUrl: "https://notes-api.yuz145.workers.dev/api/notes/",
};