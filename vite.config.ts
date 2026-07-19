import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

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
      '/api': 'http://127.0.0.1:8787',
      '/generated': 'http://127.0.0.1:8787',
    },
  },
})
