import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Toaster } from 'sonner';
import { registerSW } from 'virtual:pwa-register';
import { App } from './App';
import { AuthProvider } from './hooks/useAuth';
import { OfflineProvider } from './hooks/useOffline';
import { ApiError } from './lib/api';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      // Só retenta falhas de rede/servidor; erros de negócio (4xx) não se repetem.
      retry: (count, err) =>
        err instanceof ApiError && err.status !== 0 && err.status < 500 ? false : count < 2,
    },
    mutations: { retry: false },
  },
});

registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <OfflineProvider>
            <App />
            <Toaster richColors position="bottom-right" />
          </OfflineProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
