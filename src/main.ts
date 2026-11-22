/// <reference types="@songloft/plugin-sdk" />

// 音效工坊后端：只干两件事
// 1. 列歌单（前端要挑一个歌单发起宿主播放会话）
// 2. 存/取用户音效偏好（换设备/重装后记忆预设）
// 真正的音效应用在插件前端页面里调 window.SongloftPlugin.player 完成
//（宿主音效是客户端能力，服务端不参与）。

import { jsonResponse, createRouter } from '@songloft/plugin-sdk';

const router = createRouter();

async function callHostAPI<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const host = await songloft.plugin.getHostUrl();
  const token = await songloft.plugin.getToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const resp = await fetch(host + path, { method, headers, body: payload });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`宿主接口错误 ${resp.status}: ${t.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

router.get('/api/playlists', async () => {
  try {
    const d = await callHostAPI<any>('GET', '/api/v1/playlists?limit=500');
    const ps = (d?.playlists || d || []) as any[];
    const items = ps
      .filter((p: any) => p && p.id)
      .map((p: any) => ({ id: p.id, name: p.name, count: p.count ?? p.song_count ?? 0 }));
    return jsonResponse({ ok: true, items });
  } catch (e: any) {
    return jsonResponse({ ok: false, error: e?.message || String(e) }, 500);
  }
});

router.get('/api/prefs', async () => {
  const raw = await songloft.storage.get('prefs');
  let prefs = null;
  if (raw) { try { prefs = JSON.parse(String(raw)); } catch {} }
  return jsonResponse({ ok: true, prefs });
});

router.post('/api/prefs', async (req: any) => {
  try {
    const body = JSON.parse(req.body || '{}');
    await songloft.storage.set('prefs', JSON.stringify(body.prefs ?? {}));
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return jsonResponse({ ok: false, error: e?.message || String(e) }, 400);
  }
});

// 宿主通过全局 onHTTPRequest 分发请求
globalThis.onHTTPRequest = (req: any) => router.handle(req);
globalThis.onInit = async () => {};
globalThis.onDeinit = async () => {};
