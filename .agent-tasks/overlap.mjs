/** Видимый текст под чужим интерактивным слоем в обеих панелях. */
export async function textOverlaps(page, selectors) {
  return page.evaluate((query) => {
    const findings = []
    const visited = new Set()
    const modals = [...document.querySelectorAll('[aria-modal="true"]')].filter(node => node.getClientRects().length)
    const roots = modals.length ? [modals.at(-1)] : document.querySelectorAll(query)
    for (const root of roots) {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let text = walk.nextNode(); text; text = walk.nextNode()) {
        const label = text.data.trim().replace(/\s+/gu, ' ')
        const element = text.parentElement
        if (!label || !element || visited.has(text)) continue
        visited.add(text)
        const style = getComputedStyle(element)
        if (style.visibility !== 'visible' || style.opacity === '0' || style.pointerEvents === 'none') continue
        const range = document.createRange()
        range.selectNodeContents(text)
        for (const box of range.getClientRects()) {
          if (box.width < 5 || box.height < 4) continue
          const x = box.left + box.width / 2
          const y = box.top + box.height / 2
          if (x <= 0 || y <= 0 || x >= innerWidth || y >= innerHeight) continue
          const layers = document.elementsFromPoint(x, y)
          if (!layers.includes(element)) continue
          const top = layers[0]
          if (top === element || top.contains(element) || element.contains(top)) continue
          const cover = top.closest('button, input, textarea, [role="dialog"], [role="tooltip"], [role="status"]')
          if (!cover || cover.contains(element)) continue
          findings.push({ label: label.slice(0, 100), cover: cover.getAttribute('aria-label') ?? cover.className, x: Math.round(x), y: Math.round(y) })
        }
      }
    }
    return findings
  }, selectors.join(','))
}
