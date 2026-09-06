import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './inventory.css'
import './merchant.css'
import './campaign-pages.css'
import './world-map-layout.css'
import './table-layout.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
