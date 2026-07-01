import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the production build loads correctly under file:// in Electron.
  base: './',
  plugins: [react()],
})
