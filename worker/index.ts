import { Hono } from 'hono'
import { secureHeaders } from 'hono/secure-headers'
import { parseSuggestions, validTask, type Task } from '../src/shared/task'

type Bindings = Env & { GOOGLE_CLIENT_ID?: string; GOOGLE_CLIENT_SECRET?: string; E2E_TEST_LOGIN?: string; AI_MOCK?: string; AI_MODEL: string }
type User = { id: string; email: string; name: string; picture: string }
type Variables = { user: User }
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const encoder = new TextEncoder()
const expiresIn = 30 * 24 * 60 * 60 * 1000
const jsonError = (message: string, status: 400 | 401 | 403 | 404 | 413 | 429 | 500 | 503 = 400) => Response.json({ error: message }, { status })
const randomToken = (bytes = 32) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
async function sha256(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), byte => byte.toString(16).padStart(2, '0')).join('') }
const b64url = (data: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
function cookie(request: Request, name: string) { return request.headers.get('Cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) }
function cookieName(request: Request) { return new URL(request.url).protocol === 'https:' ? '__Host-sid' : 'sid' }
function setCookie(name: string, value: string, request: Request, maxAge: number, httpOnly = true) { return `${name}=${value}; Path=/; SameSite=Lax; Max-Age=${maxAge}${httpOnly ? '; HttpOnly' : ''}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}` }
async function issueSession(request: Request, db: D1Database, userId: string) {
  const token = randomToken()
  const now = Date.now()
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(now),
    db.prepare('INSERT INTO sessions (id,user_id,expires_at) VALUES (?,?,?)').bind(await sha256(token), userId, now + expiresIn),
  ])
  return setCookie(cookieName(request), token, request, expiresIn / 1000)
}
async function currentUser(request: Request, db: D1Database): Promise<User | null> {
  const token = cookie(request, cookieName(request))
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const row = await db.prepare('SELECT users.id,users.email,users.name,users.picture FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.id=? AND sessions.expires_at>?').bind(await sha256(token), Date.now()).first<User>()
  return row ?? null
}
function sameOrigin(request: Request) { const origin = request.headers.get('Origin'); return origin === new URL(request.url).origin }
function localHost(request: Request) { return ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname) }
function constantTimeEqual(a: string, b: string) {
  if (a.length !== 32 || b.length !== 32) return false
  let difference = 0
  for (let i = 0; i < 32; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}
async function limitedText(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get('Content-Length')) > limit) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0, result = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) { await reader.cancel(); return null }
    result += decoder.decode(value, { stream: true })
  }
  return result + decoder.decode()
}
app.use('*', secureHeaders({ contentSecurityPolicy: {
  defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'https://lh3.googleusercontent.com'],
  styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], connectSrc: ["'self'"],
  frameAncestors: ["'none'"], baseUri: ["'none'"], objectSrc: ["'none'"],
} }))
app.use('/api/*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })
app.use('/auth/*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store') })
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && !sameOrigin(c.req.raw)) return jsonError('送信元を確認できません', 403)
  await next()
})
app.get('/auth/google', async c => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return jsonError('ログイン準備中', 503)
  const state = randomToken(16)
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)).buffer)
  const challenge = b64url(await crypto.subtle.digest('SHA-256', encoder.encode(verifier)))
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({ client_id: c.env.GOOGLE_CLIENT_ID, redirect_uri: `${new URL(c.req.url).origin}/auth/google/callback`, response_type: 'code', scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' }).toString()
  const response = c.redirect(url.toString())
  response.headers.append('Set-Cookie', setCookie('oauth_state', state, c.req.raw, 600))
  response.headers.append('Set-Cookie', setCookie('oauth_verifier', verifier, c.req.raw, 600))
  return response
})
app.get('/auth/google/callback', async c => {
  const state = c.req.query('state')
  const code = c.req.query('code')
  const verifier = cookie(c.req.raw, 'oauth_verifier')
  if (!code || !state || !verifier || !constantTimeEqual(state, cookie(c.req.raw, 'oauth_state') ?? '') || !c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return jsonError('ログインを確認できません', 403)
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: c.env.GOOGLE_CLIENT_ID, client_secret: c.env.GOOGLE_CLIENT_SECRET, redirect_uri: `${new URL(c.req.url).origin}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: verifier }) })
  if (!tokenResponse.ok) return jsonError('Googleとの接続に失敗しました', 503)
  const token = await tokenResponse.json() as { access_token?: string }
  if (!token.access_token) return jsonError('ログイン情報がありません', 503)
  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${token.access_token}` } })
  if (!profileResponse.ok) return jsonError('利用者情報を取得できません', 503)
  const profile = await profileResponse.json() as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string }
  if (!profile.sub || !profile.email || !profile.email_verified) return jsonError('Googleアカウントを確認できません', 403)
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE google_sub=?').bind(profile.sub).first<{ id: string }>()
  const userId = existing?.id ?? crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO users (id,google_sub,email,name,picture,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email,name=excluded.name,picture=excluded.picture').bind(userId, profile.sub, profile.email, profile.name ?? '', profile.picture ?? '', Date.now()).run()
  const saved = await c.env.DB.prepare('SELECT id FROM users WHERE google_sub=?').bind(profile.sub).first<{ id: string }>()
  if (!saved) return jsonError('利用者情報を保存できません', 500)
  const response = c.redirect('/')
  response.headers.append('Set-Cookie', await issueSession(c.req.raw, c.env.DB, saved.id))
  response.headers.append('Set-Cookie', setCookie('oauth_state', '', c.req.raw, 0))
  response.headers.append('Set-Cookie', setCookie('oauth_verifier', '', c.req.raw, 0))
  return response
})
app.get('/auth/test-login', async c => {
  if (c.env.E2E_TEST_LOGIN !== '1' || !localHost(c.req.raw)) return jsonError('見つかりません', 404)
  const email = c.req.query('email')
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return jsonError('メールアドレスを確認してください')
  const sub = `test:${email}`
  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE google_sub=?').bind(sub).first<{ id: string }>()
  const userId = existing?.id ?? crypto.randomUUID()
  await c.env.DB.prepare('INSERT INTO users (id,google_sub,email,name,picture,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email').bind(userId, sub, email, 'テスト利用者', '', Date.now()).run()
  const saved = await c.env.DB.prepare('SELECT id FROM users WHERE google_sub=?').bind(sub).first<{ id: string }>()
  if (!saved) return jsonError('利用者情報を保存できません', 500)
  const response = c.redirect('/')
  response.headers.append('Set-Cookie', await issueSession(c.req.raw, c.env.DB, saved.id))
  return response
})
app.get('/api/me', async c => c.json({ user: await currentUser(c.req.raw, c.env.DB) }))
app.post('/auth/logout', async c => {
  const token = cookie(c.req.raw, cookieName(c.req.raw))
  if (token) await c.env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(await sha256(token)).run()
  const response = c.json({ ok: true })
  response.headers.append('Set-Cookie', setCookie(cookieName(c.req.raw), '', c.req.raw, 0))
  return response
})
app.use('/api/sync', async (c, next) => { const user = await currentUser(c.req.raw, c.env.DB); if (!user) return jsonError('ログインが必要です', 401); c.set('user', user); await next() })
app.post('/api/sync', async c => {
  const raw = await limitedText(c.req.raw, 1024 * 1024)
  if (raw === null) return jsonError('同期データが大きすぎます', 413)
  let body: unknown
  try { body = JSON.parse(raw) } catch { return jsonError('入力を確認してください') }
  const data = body as { since?: unknown; changes?: unknown }
  if (!data || typeof data.since !== 'number' || !Number.isFinite(data.since) || data.since < 0 || !Array.isArray(data.changes) || !data.changes.every(validTask)) return jsonError('同期データを確認してください')
  if (data.changes.length > 200) return jsonError('同期は200件ずつ送ってください', 413)
  const userId = c.get('user').id
  const changes = data.changes as Task[]
  if (changes.length) {
    const count = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM tasks WHERE user_id=?').bind(userId).first<{ total: number }>()
    const uniqueIds = [...new Set(changes.map(task => task.id))]
    const placeholders = uniqueIds.map(() => '?').join(',')
    const existing = await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM tasks WHERE user_id=? AND id IN (${placeholders})`).bind(userId, ...uniqueIds).first<{ total: number }>()
    if ((count?.total ?? 0) + uniqueIds.length - (existing?.total ?? 0) > 5000) return jsonError('タスクは5000件までです', 400)
    const statements = changes.map(task => c.env.DB.prepare('INSERT INTO tasks (id,user_id,text,status,archived,deleted,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,status=excluded.status,archived=excluded.archived,deleted=excluded.deleted,position=excluded.position,created_at=excluded.created_at,updated_at=excluded.updated_at WHERE tasks.user_id=excluded.user_id AND excluded.updated_at>tasks.updated_at').bind(task.id, userId, task.text, task.status, Number(task.archived), Number(task.deleted), task.position, task.createdAt, task.updatedAt))
    try { await c.env.DB.batch(statements) } catch { return jsonError('タスクを保存できませんでした', 400) }
  }
  const result = await c.env.DB.prepare('SELECT id,text,status,archived,deleted,position,created_at AS createdAt,updated_at AS updatedAt FROM tasks WHERE user_id=? AND updated_at>? ORDER BY updated_at ASC').bind(userId, data.since).all<Record<string, unknown>>()
  return c.json({ tasks: result.results.map(row => ({ ...row, archived: Boolean(row.archived), deleted: Boolean(row.deleted) })) })
})
app.use('/api/ai/*', async (c, next) => { const user = await currentUser(c.req.raw, c.env.DB); if (!user) return jsonError('ログインが必要です', 401); c.set('user', user); await next() })
app.post('/api/ai/suggest', async c => {
  let body: unknown
  try { body = await c.req.json() } catch { return jsonError('文章を確認してください') }
  const text = (body as { text?: unknown })?.text
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) return jsonError('文章は2000文字以内で入力してください')
  const userId = c.get('user').id
  const now = Date.now()
  const minuteWindow = `m:${String(Math.floor(now / 60000)).padStart(12, '0')}`
  const dayWindow = `d:${String(Math.floor(now / 86400000)).padStart(12, '0')}`
  await c.env.DB.prepare("DELETE FROM rate_limits WHERE (window LIKE 'm:%' AND window<?) OR (window LIKE 'd:%' AND window<?)").bind(minuteWindow, dayWindow).run()
  const increment = 'INSERT INTO rate_limits (user_id,window,count) VALUES (?,?,1) ON CONFLICT(user_id,window) DO UPDATE SET count=count+1 WHERE count<?'
  const minute = await c.env.DB.prepare(increment).bind(userId, minuteWindow, 10).run()
  if (minute.meta.changes === 0) return jsonError('少し待ってから試してください', 429)
  const day = await c.env.DB.prepare(increment).bind(userId, dayWindow, 50).run()
  if (day.meta.changes === 0) return jsonError('本日の利用回数に達しました', 429)
  if (c.env.AI_MOCK === '1' && localHost(c.req.raw)) return c.json({ suggestions: ['内容を確認する', '次の行動を決める'] })
  try {
    const ai = c.env.AI as unknown as { run: (model: string, input: { messages: { role: string; content: string }[]; max_tokens: number }) => Promise<unknown> }
    const result = await ai.run(c.env.AI_MODEL, { max_tokens: 512, messages: [{ role: 'system', content: '日本語のメモを短い実行可能なタスク名に分けてください。最大8件。JSON配列だけを返してください。説明は不要です。' }, { role: 'user', content: text }] })
    const raw = typeof result === 'string' ? result : String((result as { response?: unknown })?.response ?? JSON.stringify(result))
    return c.json({ suggestions: parseSuggestions(raw) })
  } catch { return jsonError('提案を作れませんでした', 503) }
})
export default app
