import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react'
import type { PanInfo } from 'motion/react'
import { mergeTasks, statuses, validTask, type Status, type Task } from './shared/task'
import './App.css'

type User = { id: string; email: string; name: string; picture: string }
const storageKey = 'memo-flick-tasks-v1'
const previousUserKey = 'memo-flick-previous-user-v1'
const labels: Record<Status, string> = { inbox: 'メモ', todo: 'やる', doing: '進行中', done: '完了' }
const textarea = () => document.getElementById('quick-memo') as HTMLTextAreaElement
function loadTasks(): Task[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]'); return Array.isArray(value) ? value.filter(validTask) : [] } catch { return [] }
}
function loadCursor(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    const value = Number(raw)
    return raw !== null && Number.isFinite(value) && value >= 0 ? value : fallback
  } catch { return fallback }
}
function App() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks)
  const tasksRef = useRef(tasks)
  const [status, setStatus] = useState<Status>('inbox')
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const userRef = useRef<User | null>(null)
  const [composerText, setComposerText] = useState(() => textarea()?.value ?? '')
  const [ready, setReady] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [toast, setToast] = useState<{ id: number; text: string; undo?: Task } | null>(null)
  const toastId = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sheet, setSheet] = useState(false)
  const [loading, setLoading] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [burst, setBurst] = useState(false)
  const reduceMotion = useReducedMotion()
  const receiveCursor = useRef(0)
  const sentCursor = useRef(-1)
  const lastLocalTimestamp = useRef(Math.max(0, ...tasks.map(task => task.updatedAt)))
  const syncGeneration = useRef(0)
  const syncBusy = useRef(false)
  const syncRef = useRef<() => Promise<void>>(async () => {})
  const syncAgain = useRef(false)
  const nextTimestamp = useCallback(() => {
    lastLocalTimestamp.current = Math.max(Date.now(), lastLocalTimestamp.current + 1, sentCursor.current + 1)
    return lastLocalTimestamp.current
  }, [])
  const clearLocalTasks = useCallback(() => {
    syncGeneration.current++
    tasksRef.current = []
    setTasks([])
    lastLocalTimestamp.current = 0
    receiveCursor.current = 0
    sentCursor.current = -1
    try {
      localStorage.removeItem(storageKey)
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('memo-flick-cursor-') || key.startsWith('memo-flick-sent-')) localStorage.removeItem(key)
      }
    } catch { /* local storage may be unavailable */ }
  }, [])
  const update = useCallback((next: Task[] | ((current: Task[]) => Task[])) => {
    const result = typeof next === 'function' ? next(tasksRef.current) : next
    tasksRef.current = result
    lastLocalTimestamp.current = Math.max(lastLocalTimestamp.current, ...result.map(task => task.updatedAt))
    setTasks(result)
    try { localStorage.setItem(storageKey, JSON.stringify(result)) } catch { /* local storage may be unavailable */ }
  }, [])
  const showToast = useCallback((text: string, undo?: Task) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    const id = ++toastId.current
    setToast({ id, text, undo })
    toastTimer.current = setTimeout(() => {
      setToast(current => current?.id === id ? null : current)
      toastTimer.current = null
    }, 4000)
  }, [])
  useEffect(() => {
    const timer = setTimeout(() => {
      document.getElementById('skeleton')?.classList.add('gone')
      document.getElementById('root')?.classList.add('ready')
      setReady(true)
    }, 350)
    fetch('/api/me').then(r => r.json()).then((data: { user?: User | null }) => {
      const account = data.user ?? null
      const previousUser = localStorage.getItem(previousUserKey)
      if (account && previousUser && previousUser !== account.id) clearLocalTasks()
      userRef.current = account
      receiveCursor.current = account ? loadCursor(`memo-flick-cursor-${account.id}`, 0) : 0
      sentCursor.current = account ? loadCursor(`memo-flick-sent-${account.id}`, -1) : -1
      if (account) localStorage.setItem(previousUserKey, account.id)
      setUser(account)
    }).catch(() => setUser(null))
    return () => { clearTimeout(timer); if (toastTimer.current) clearTimeout(toastTimer.current) }
  }, [clearLocalTasks])
  const sync = useCallback(async () => {
    const account = userRef.current
    if (!account || !navigator.onLine) return
    if (syncBusy.current) { syncAgain.current = true; return }
    syncBusy.current = true
    const generation = syncGeneration.current
    try {
      const pending = tasksRef.current.filter(task => task.updatedAt > sentCursor.current).sort((a, b) => a.updatedAt - b.updatedAt)
      const batches: Task[][] = []
      const encoder = new TextEncoder()
      let batch: Task[] = [], batchBytes = 64
      for (const task of pending) {
        const bytes = encoder.encode(JSON.stringify(task)).byteLength + 1
        if (batch.length && (batch.length >= 200 || batchBytes + bytes > 1024 * 1024)) {
          batches.push(batch)
          batch = []
          batchBytes = 64
        }
        batch.push(task)
        batchBytes += bytes
      }
      if (batch.length || !batches.length) batches.push(batch)
      for (const changes of batches) {
        const response = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ since: receiveCursor.current, changes }) })
        if (generation !== syncGeneration.current || userRef.current?.id !== account.id) return
        if (response.status === 401) { clearLocalTasks(); userRef.current = null; setUser(null); return }
        if (!response.ok) throw new Error('sync failed')
        const data: { tasks?: unknown } = await response.json()
        if (generation !== syncGeneration.current || userRef.current?.id !== account.id) return
        const remote = Array.isArray(data.tasks) ? data.tasks.filter(validTask) : []
        if (remote.length) {
          receiveCursor.current = Math.max(receiveCursor.current, ...remote.map(task => task.updatedAt))
          localStorage.setItem(`memo-flick-cursor-${account.id}`, String(receiveCursor.current))
          const merged = mergeTasks(tasksRef.current, remote)
          if (JSON.stringify(merged) !== JSON.stringify(tasksRef.current)) update(merged)
        }
      }
      if (pending.length) {
        sentCursor.current = Math.max(sentCursor.current, pending[pending.length - 1].updatedAt)
        localStorage.setItem(`memo-flick-sent-${account.id}`, String(sentCursor.current))
      }
    } catch { /* retry on the next change, focus or network return */ }
    finally {
      syncBusy.current = false
      if (syncAgain.current) { syncAgain.current = false; void syncRef.current() }
    }
  }, [clearLocalTasks, update])
  useEffect(() => { syncRef.current = sync }, [sync])
  useEffect(() => { if (!user) return; const timer = setTimeout(() => void sync(), 500); return () => clearTimeout(timer) }, [tasks, user, sync])
  useEffect(() => {
    const wake = () => { if (document.visibilityState === 'visible') void sync() }
    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', wake)
    return () => { window.removeEventListener('online', wake); document.removeEventListener('visibilitychange', wake) }
  }, [sync])
  const add = useCallback(() => {
    const input = textarea()
    const text = input.value.trim()
    if (!text) { input.focus(); return }
    const now = nextTimestamp()
    update(current => [{ id: crypto.randomUUID(), text, status: 'inbox', archived: false, deleted: false, position: Math.min(0, ...current.map(task => task.position)) - 1, createdAt: now, updatedAt: now }, ...current])
    input.value = ''; setComposerText(''); setStatus('inbox'); input.focus()
    setBurst(true); setTimeout(() => setBurst(false), 550)
  }, [nextTimestamp, update])
  useEffect(() => {
    const input = textarea()
    const form = document.getElementById('composer-form') as HTMLFormElement
    const onInput = () => setComposerText(input.value)
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); add() } }
    const onSubmit = (event: SubmitEvent) => { event.preventDefault(); add() }
    input.addEventListener('input', onInput); input.addEventListener('keydown', onKey); form.addEventListener('submit', onSubmit)
    return () => { input.removeEventListener('input', onInput); input.removeEventListener('keydown', onKey); form.removeEventListener('submit', onSubmit) }
  }, [add])
  const changeTask = (task: Task, patch: Partial<Task>) => update(current => current.map(item => item.id === task.id ? { ...item, ...patch, updatedAt: nextTimestamp() } : item))
  const move = (task: Task, direction: -1 | 1) => {
    const index = statuses.indexOf(task.status)
    if (index === 0 && direction === -1) { changeTask(task, { deleted: true }); showToast('削除しました', task) }
    else if (index === 3 && direction === 1) { changeTask(task, { archived: true }); showToast('アーカイブしました', task) }
    else { changeTask(task, { status: statuses[index + direction] }); showToast(`${labels[statuses[index + direction]]}へ移動しました`, task) }
  }
  const undo = () => { if (toast?.undo) changeTask(toast.undo, toast.undo); setToast(null); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = null }
  const login = async () => {
    try { const response = await fetch('/auth/google', { redirect: 'manual' }); if (response.status === 503) { showToast('ログイン準備中'); return }; window.location.assign('/auth/google') } catch { showToast('ログイン準備中') }
  }
  const logout = async () => {
    try {
      const response = await fetch('/auth/logout', { method: 'POST' })
      if (!response.ok) throw new Error('logout failed')
      clearLocalTasks()
      userRef.current = null
      setUser(null)
      showToast('ログアウトしました')
    } catch { showToast('ログアウトできませんでした') }
  }
  const suggest = async (text: string) => {
    if (!user || !text.trim()) return
    setSheet(true); setLoading(true); setSuggestions([]); setChecked([])
    try {
      const response = await fetch('/api/ai/suggest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      if (!response.ok) throw new Error('suggest failed')
      const data: { suggestions?: string[] } = await response.json()
      const items = data.suggestions ?? []
      setSuggestions(items); setChecked(items)
    } catch { setSheet(false); showToast('提案を作れませんでした') }
    finally { setLoading(false) }
  }
  const addSuggestions = () => {
    const now = nextTimestamp()
    update(current => [...checked.map((text, index): Task => ({ id: crypto.randomUUID(), text, status: 'todo', archived: false, deleted: false, position: Math.min(0, ...current.map(task => task.position)) - checked.length + index, createdAt: now + index, updatedAt: now + index })), ...current])
    setSheet(false); setStatus('todo'); showToast(`${checked.length}件追加しました`)
  }
  const visible = useMemo(() => user === undefined ? [] : tasks.filter(task => !task.deleted && !task.archived && task.status === status).sort((a, b) => a.position - b.position), [tasks, status, user])
  const counts = useMemo(() => Object.fromEntries(statuses.map(item => [item, user === undefined ? 0 : tasks.filter(task => !task.deleted && !task.archived && task.status === item).length])) as Record<Status, number>, [tasks, user])
  return <MotionConfig reducedMotion="user"><main className="app" aria-busy={!ready}>
    <div className="topbar">
      <button className="ai-main" disabled={!user || !composerText.trim()} onClick={() => void suggest(textarea().value)}>✦ AIで整理</button>
      <div className="account">{user ? <><span className="initial" aria-hidden="true">{user.picture ? <img src={user.picture} alt="" referrerPolicy="no-referrer" /> : user.name.slice(0, 1)}</span><button onClick={() => void logout()}>ログアウト</button></> : <button onClick={() => void login()}>Googleでログイン</button>}</div>
    </div>
    {burst && <motion.span className="composer-burst" initial={{ y: -35, opacity: 1, scale: .6 }} animate={{ y: 125, opacity: 0, scale: 1.8 }} transition={{ duration: reduceMotion ? 0 : .55 }} />}
    <nav className="tabs" aria-label="状態">
      {statuses.map(item => <button key={item} className={`tab ${status === item ? 'selected' : ''}`} aria-current={status === item ? 'page' : undefined} onClick={() => setStatus(item)}>{status === item && <motion.span className="tab-indicator" layoutId="active-tab" transition={{ type: 'spring', stiffness: 360, damping: 30 }} />}<span className="tab-label">{labels[item]} <span className="tab-count">{counts[item]}</span></span></button>)}
    </nav>
    <div className="list"><AnimatePresence mode="popLayout">{visible.length ? visible.map((task, index) => <TaskCard key={task.id} task={task} index={index} editing={editing === task.id} editText={editText} setEditText={setEditText} onEdit={() => { setEditing(task.id); setEditText(task.text) }} onCancel={() => setEditing(null)} onSave={() => { if (editText.trim()) changeTask(task, { text: editText.trim() }); setEditing(null) }} onMove={direction => move(task, direction)} onSuggest={() => void suggest(task.text)} canSuggest={Boolean(user) && task.status === 'inbox'} reduceMotion={Boolean(reduceMotion)} />) : <motion.div key={`empty-${status}`} className="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>{status === 'inbox' ? 'メモなし' : `${labels[status]}の項目なし`}</motion.div>}</AnimatePresence></div>
    <AnimatePresence>{toast && <motion.div key="toast" className="toast" role="status" initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 30 }} transition={{ duration: .15 }}>{toast.text}{toast.undo && <button onClick={undo}>元に戻す</button>}</motion.div>}</AnimatePresence>
    <AnimatePresence>{sheet && <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSheet(false)}><motion.div className="sheet" role="dialog" aria-modal="true" aria-label="タスク候補" initial={{ y: 300 }} animate={{ y: 0 }} exit={{ y: 300 }} onClick={event => event.stopPropagation()}><div className="sheet-title">タスク候補</div>{loading ? <><div className="sheet-loading"/><div className="sheet-loading"/><div className="sheet-loading"/></> : suggestions.length ? suggestions.map(item => <label className="candidate" key={item}><input type="checkbox" checked={checked.includes(item)} onChange={() => setChecked(current => current.includes(item) ? current.filter(x => x !== item) : [...current, item])} />{item}</label>) : <div className="empty">候補なし</div>}<div className="sheet-actions"><button onClick={() => setSheet(false)}>閉じる</button><button className="primary" disabled={loading || !checked.length} onClick={addSuggestions}>選んで追加</button></div></motion.div></motion.div>}</AnimatePresence>
  </main></MotionConfig>
}

type CardProps = { task: Task; index: number; editing: boolean; editText: string; setEditText: (value: string) => void; onEdit: () => void; onCancel: () => void; onSave: () => void; onMove: (direction: -1 | 1) => void; onSuggest: () => void; canSuggest: boolean; reduceMotion: boolean }
function TaskCard({ task, index, editing, editText, setEditText, onEdit, onCancel, onSave, onMove, onSuggest, canSuggest, reduceMotion }: CardProps) {
  const [dragX, setDragX] = useState(0)
  const [strong, setStrong] = useState(false)
  const moved = useRef(false)
  const card = useRef<HTMLDivElement>(null)
  const direction = dragX >= 0 ? 1 : -1
  const destination = direction === 1 ? (task.status === 'done' ? 'アーカイブ' : labels[statuses[statuses.indexOf(task.status) + 1]]) : (task.status === 'inbox' ? '削除' : labels[statuses[statuses.indexOf(task.status) - 1]])
  const onDrag = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    setDragX(info.offset.x)
    if (Math.abs(info.offset.x) > 8) moved.current = true
    const passed = Math.abs(info.offset.x) >= (card.current?.offsetWidth ?? 320) * .35 || Math.abs(info.velocity.x) > 650
    if (passed && !strong && navigator.vibrate) navigator.vibrate(10)
    setStrong(passed)
  }
  const end = (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    const passed = Math.abs(info.offset.x) >= (card.current?.offsetWidth ?? 320) * .35 || (Math.abs(info.offset.x) > 25 && Math.abs(info.velocity.x) > 650)
    if (!passed) setDragX(0)
    setStrong(false)
    if (passed) onMove(info.offset.x > 0 ? 1 : -1)
    setTimeout(() => { moved.current = false }, 100)
  }
  return <motion.div className="swipe-wrap" layout initial={{ opacity: 0, y: reduceMotion ? 0 : 30, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, x: reduceMotion ? 0 : dragX < 0 ? -400 : 400, scale: .93 }} transition={{ type: 'spring', stiffness: 330, damping: 29, delay: reduceMotion ? 0 : Math.min(index * .045, .3) }}>
    <div className={`swipe-bg ${direction === 1 ? 'right' : 'left'} ${strong ? 'strong' : ''}`} aria-hidden="true"><span>{direction === 1 ? destination : ''}</span><span>{direction === -1 ? destination : ''}</span></div>
    <motion.div ref={card} className="task-card" drag={editing ? false : 'x'} dragSnapToOrigin dragMomentum={false} onDrag={onDrag} onDragEnd={end} onClick={() => { if (!moved.current && !editing) onEdit() }}>
      {editing ? <><textarea className="editor" maxLength={2000} value={editText} onChange={event => setEditText(event.target.value)} onClick={event => event.stopPropagation()} autoFocus /><div className="edit-actions"><button onClick={event => { event.stopPropagation(); onCancel() }}>やめる</button><button onClick={event => { event.stopPropagation(); onSave() }}>保存</button></div></> : <><div className="task-text">{task.text}</div><div className="task-meta"><time dateTime={new Date(task.createdAt).toISOString()}>{new Date(task.createdAt).toLocaleDateString('ja-JP')}</time>{canSuggest && <button className="card-ai" onClick={event => { event.stopPropagation(); onSuggest() }}>AIで整理</button>}</div></>}
    </motion.div>
  </motion.div>
}
export default App
