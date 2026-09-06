import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Порт сервера берётся из того же AGENT_PORT, которым его запускают. Пока адрес
// был вписан жёстко, второй клиент проксировал в первый сервер, и параллельно
// поднять своё приложение было нельзя — а значит, и посмотреть правку
// интерфейса глазами тоже.
const DEFAULT_AGENT_PORT = 8787

function resolveAgentPort(raw: string | undefined): number {
  const parsed = Number(raw)
  // Подставлять в адрес мусор из окружения молча нельзя: прокси тогда уходит
  // в никуда, а выглядит это как отказ сервера, а не как опечатка в порту.
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_AGENT_PORT
}

export default defineConfig(({ mode }) => ({
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
    proxy: (() => {
      // Порт живёт в .env — оттуда же его берёт сервер через dotenv. Без
      // loadEnv конфиг видел бы только переменные оболочки, и заданный в .env
      // порт молча расходился бы с тем, куда стучится прокси: сервер отвечает,
      // клиент получает 502, и выглядит это как поломка сервера.
      // Префикс пустой намеренно: AGENT_PORT не начинается с VITE_ и в
      // браузер не попадает — его читает только этот конфиг.
      const env = loadEnv(mode, process.cwd(), '')
      const agentTarget = `http://127.0.0.1:${resolveAgentPort(env.AGENT_PORT)}`
      // Сохраняем адрес браузера: сервер сравнивает Origin с Host. Подмена
      // Host адресом backend ломает вход на другом порту и из локальной сети.
      return {
        '/api': { target: agentTarget, changeOrigin: false },
        '/generated': { target: agentTarget, changeOrigin: false },
      }
    })(),
  },
}))
