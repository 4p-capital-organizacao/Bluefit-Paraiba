import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig({
  plugins: [
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
    // Gera dist/stats.html após cada build (gzipSize/brotliSize ligados).
    // Abrir no navegador para ver o tree de chunks e identificar deps pesadas.
    visualizer({
      filename: 'dist/stats.html',
      gzipSize: true,
      brotliSize: true,
      template: 'treemap',
    }) as any,
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Separa vendors em chunks dedicados para melhorar cache do navegador
        // e reduzir o chunk inicial de 886KB. Cada grupo só baixa quando uma
        // rota que o usa é montada.
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router'],
          'supabase': ['@supabase/supabase-js'],
          'charts': ['recharts'],
          'dnd': ['react-dnd', 'react-dnd-html5-backend'],
          'query': ['@tanstack/react-query', '@tanstack/react-query-devtools'],
          'date-fns': ['date-fns', 'react-day-picker'],
        },
      },
    },
  },
})
