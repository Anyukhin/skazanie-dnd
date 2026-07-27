import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Порт сервера берётся из того же AGENT_PORT, которым его запускают
// (`AGENT_PORT=8788 pnpm dev:agent`). Пока адрес был вписан жёстко, второй
// клиент проксировал в первый сервер, и параллельно поднять своё приложение
// было нельзя — а значит, и посмотреть правку интерфейса глазами тоже.
const DEFAULT_AGENT_PORT = 8787

function resolveAgentPort(raw: string | undefined): number {
  const parsed = Number(raw)
  // Подставлять в адрес мусор из окружения молча нельзя: прокси тогда уходит
  // в никуда, а выглядит это как отказ сервера, а не как опечатка в порту.
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_AGENT_PORT
}

const agentTarget = `http://127.0.0.1:${resolveAgentPort(process.env.AGENT_PORT)}`

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('dndsu-spells-0-6.json')) return 'spell-catalog'
          if (id.includes('dndsu-class-actions-1-12.json')) return 'class-catalog'
          if (id.includes('node_modules/react') || id.includes('node_modules/lucide-react')) return 'ui-vendor'
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': agentTarget,
      '/generated': agentTarget,
    },
  },
})
