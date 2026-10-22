import { test, expect, type Page } from '@playwright/test'

async function addMemo(page: Page, text: string) {
  await page.locator('#quick-memo').fill(text)
  await page.getByRole('button', { name: 'メモを追加' }).click()
  await expect(page.locator('.task-text', { hasText: text })).toBeVisible()
}
async function swipe(page: Page, text: string, direction: 1 | -1) {
  const card = page.locator('.task-card', { hasText: text })
  // 人がカードの到着を見てからはじくのと同じく、登場アニメが止まるまで待つ
  let box = await card.boundingBox()
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(50)
    const next = await card.boundingBox()
    if (box && next && Math.abs(next.x - box.x) < .5 && Math.abs(next.y - box.y) < .5) break
    box = next
  }
  if (!box) throw new Error('カードがありません')
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y); await page.mouse.down()
  await page.mouse.move(x + direction * box.width * .45, y, { steps: 12 })
  await page.mouse.up()
}
async function testLogin(page: Page, email: string) {
  await page.goto(`/auth/test-login?email=${encodeURIComponent(email)}`)
  await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible()
}
test('すぐ入力でき、読み込み前の文字も残る', async ({ page }) => {
  await page.route('**/src/main.tsx', async route => { await new Promise(resolve => setTimeout(resolve, 800)); await route.continue() })
  await page.goto('/', { waitUntil: 'commit' })
  await expect(page.locator('#skeleton')).toBeVisible()
  await expect(page.locator('#quick-memo')).toBeFocused({ timeout: 1000 })
  await page.keyboard.type('読み込み前のメモ')
  await expect(page.locator('#quick-memo')).toHaveValue('読み込み前のメモ')
  await expect(page.locator('#root')).toHaveClass(/ready/)
  await expect(page.locator('#quick-memo')).toHaveValue('読み込み前のメモ')
  await expect(page.locator('#skeleton')).toHaveClass(/gone/)
})
test('メモの追加、保存、編集と画面幅', async ({ page }) => {
  await page.goto('/')
  await addMemo(page, '買い物をする')
  await page.reload()
  await expect(page.locator('.task-text', { hasText: '買い物をする' })).toBeVisible()
  await page.locator('.task-card', { hasText: '買い物をする' }).click()
  await page.locator('.editor').fill('牛乳を買う')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.task-text', { hasText: '牛乳を買う' })).toBeVisible()
  expect(await page.locator('h1,h2').count()).toBe(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})
test('左右のフリック、削除と元に戻す', async ({ page }) => {
  await page.goto('/')
  await addMemo(page, '歩く')
  for (const label of ['やる', '進行中', '完了']) {
    await swipe(page, '歩く', 1)
    await page.locator('.tab', { hasText: label }).click()
    await expect(page.locator('.task-text', { hasText: '歩く' })).toBeVisible()
  }
  await swipe(page, '歩く', 1)
  await expect(page.locator('.task-text', { hasText: '歩く' })).toHaveCount(0)
  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('.task-text', { hasText: '歩く' })).toBeVisible()
  await swipe(page, '歩く', -1)
  await page.locator('.tab', { hasText: '進行中' }).click()
  await expect(page.locator('.task-text', { hasText: '歩く' })).toBeVisible()
  await page.locator('.tab', { hasText: 'メモ' }).click()
  await addMemo(page, '削除する')
  await swipe(page, '削除する', -1)
  await expect(page.locator('.task-text', { hasText: '削除する' })).toHaveCount(0)
  await page.getByRole('button', { name: '元に戻す' }).click()
  await expect(page.locator('.task-text', { hasText: '削除する' })).toBeVisible()
})
test('未ログインではAIが無効でログインだけ表示', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Googleでログイン' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ログアウト' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'AIで整理' }).first()).toBeDisabled()
})
test('入力欄が空でも最新のメモをAIで整理できる', async ({ page }) => {
  const email = `ai-empty-${Date.now()}@example.test`
  await testLogin(page, email)
  await page.getByRole('button', { name: 'AIで整理' }).first().click()
  await expect(page.getByRole('status')).toHaveText('整理するメモがありません')
  await addMemo(page, '旅行の準備')
  await expect(page.locator('#quick-memo')).toHaveValue('')
  await page.getByRole('button', { name: 'AIで整理' }).first().click()
  await expect(page.getByRole('dialog', { name: 'タスク候補' })).toBeVisible()
})
test('端末メモを同期し、別の画面とAI提案に反映', async ({ page, browser }) => {
  const email = `e2e-${Date.now()}@example.test`
  await page.goto('/')
  await addMemo(page, '旅行の準備')
  await testLogin(page, email)
  await expect.poll(async () => (await page.request.post('/api/sync', { headers: { Origin: new URL(page.url()).origin }, data: { since: 0, changes: [] } })).json().then(data => data.tasks.some((task: { text: string }) => task.text === '旅行の準備'))).toBe(true)
  const context = await browser.newContext()
  const other = await context.newPage()
  await testLogin(other, email)
  await expect(other.locator('.task-text', { hasText: '旅行の準備' })).toBeVisible()
  await other.locator('#quick-memo').fill('旅行を計画')
  await other.getByRole('button', { name: 'AIで整理' }).first().click()
  await expect(other.getByRole('dialog', { name: 'タスク候補' })).toBeVisible()
  await expect(other.locator('.candidate')).toHaveCount(2)
  await other.getByRole('button', { name: '選んで追加' }).click()
  await expect(other.locator('.task-text', { hasText: '内容を確認する' })).toBeVisible()
  await context.close()
})

test('ログアウトで端末のタスクが消える', async ({ page }) => {
  const email = `logout-${Date.now()}@example.test`
  await testLogin(page, email)
  await addMemo(page, 'ログアウト前のメモ')
  await page.getByRole('button', { name: 'ログアウト' }).click()
  await expect(page.getByText('ログアウトしました')).toBeVisible()
  await expect(page.locator('.task-text', { hasText: 'ログアウト前のメモ' })).toHaveCount(0)
  expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('memo-flick-cursor-') || key.startsWith('memo-flick-sent-') || key === 'memo-flick-tasks-v1'))).toBe(false)
  await page.reload()
  await expect(page.locator('.task-text', { hasText: 'ログアウト前のメモ' })).toHaveCount(0)
})
