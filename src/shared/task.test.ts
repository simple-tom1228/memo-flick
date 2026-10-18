import { describe, expect, it } from 'vitest'
import { mergeTasks, parseSuggestions, type Task } from './task'
const base: Task = { id: '11111111-1111-4111-8111-111111111111', text: '古い', status: 'inbox', archived: false, deleted: false, position: 0, createdAt: 1, updatedAt: 1 }
describe('同期のマージ', () => {
  it('新しい変更が勝つ', () => expect(mergeTasks([base], [{ ...base, text: '新しい', updatedAt: 2 }])[0].text).toBe('新しい'))
  it('古い変更と同時刻の変更では端末側を維持する', () => expect(mergeTasks([base], [{ ...base, text: '競合', updatedAt: 1 }])[0].text).toBe('古い'))
  it('削除の墓標を保持する', () => expect(mergeTasks([base], [{ ...base, deleted: true, updatedAt: 3 }])[0].deleted).toBe(true))
})
describe('AI候補', () => {
  it('JSON配列とオブジェクトを読む', () => { expect(parseSuggestions('["買い物"]')).toEqual(['買い物']); expect(parseSuggestions('{"tasks":["洗濯"]}')).toEqual(['洗濯']) })
  it('壊れたJSONは行ごとに救い、最大8件にする', () => expect(parseSuggestions(Array.from({ length: 10 }, (_, i) => `- 項目${i}`).join('\n'))).toHaveLength(8))
})
