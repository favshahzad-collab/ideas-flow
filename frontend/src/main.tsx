import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './components/ui/ErrorBoundary.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outside the router, so it still catches a throw from the router,
        the auth provider or the shell itself. The per-route boundary in
        `AppLayout` handles anything narrower and keeps the sidebar. */}
    <ErrorBoundary full>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
