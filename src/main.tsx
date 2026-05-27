import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ErrorBoundary'
import { AppProvider } from './context/AppContext'
import { ScanProvider } from './context/ScanContext'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <AppProvider>
        <ScanProvider>
          <App />
        </ScanProvider>
      </AppProvider>
    </ErrorBoundary>
  </StrictMode>,
)
