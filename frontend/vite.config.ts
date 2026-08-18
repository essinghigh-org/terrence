import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from "path"

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('react') || id.includes('react-dom') || id.includes('react-router')) {
              return 'vendor-react';
            }
            if (id.includes('@xyflow')) {
              return 'vendor-flow';
            }
            if (id.includes('@base-ui')) {
              return 'vendor-base-ui';
            }
            return 'vendor';
          }
          if (
            id.includes('/src/components/ui/') ||
            id.includes('/src/lib/') ||
            id.includes('/src/hooks/') ||
            id.includes('/src/components/PageHeader') ||
            id.includes('/src/components/Breadcrumbs') ||
            id.includes('/src/components/EmptyState')
          ) {
            return 'ui-common';
          }
        },
      },
    },
  },
})
