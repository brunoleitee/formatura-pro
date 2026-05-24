import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppProvider } from './context/AppContext'
import { ScanProvider } from './context/ScanContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <ScanProvider>
        <App />
      </ScanProvider>
    </AppProvider>
  </StrictMode>,
)
