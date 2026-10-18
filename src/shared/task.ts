export const statuses = ['inbox', 'todo', 'doing', 'done'] as const
export type Status = typeof statuses[number]
export type Task = { id: string; text: string; status: Status; archived: boolean; deleted: boolean; position: number; createdAt: number; updatedAt: number }

export function validTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') return false
  const t = value as Record<string, unknown>
  return typeof t.id === 'string' && /^[0-9a-f-]{36}$/i.test(t.id) && typeof t.text === 'string' && t.text.length <= 2000 && statuses.includes(t.status as Status) && typeof t.archived === 'boolean' && typeof t.deleted === 'boolean' && typeof t.position === 'number' && Number.isFinite(t.position) && typeof t.createdAt === 'number' && Number.isFinite(t.createdAt) && typeof t.updatedAt === 'number' && Number.isFinite(t.updatedAt)
}

export function mergeTasks(local: Task[], remote: Task[]): Task[] {
  const byId = new Map(local.map(task => [task.id, task]))
  for (const task of remote) {
    const current = byId.get(task.id)
    if (!current || task.updatedAt > current.updatedAt) byId.set(task.id, task)
  }
  return [...byId.values()]
}

export function parseSuggestions(raw: string): string[] {
  const clean = (text: string) => text.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim().slice(0, 100)
  let items: unknown
  try {
    const normalized = raw.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
    const parsed: unknown = JSON.parse(normalized)
    items = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).tasks ?? (parsed as Record<string, unknown>).titles : undefined)
  } catch { /* line fallback below */ }
  const lines = Array.isArray(items) ? items : raw.replace(/```(?:json)?/g, '').split(/\r?\n/)
  return [...new Set(lines.filter((item): item is string => typeof item === 'string').map(clean).filter(Boolean))].slice(0, 8)
}
