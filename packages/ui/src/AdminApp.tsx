import { BrowserRouter } from 'react-router';
import { App } from './App';
import { WebSocketProvider } from './hooks/useWebSocket';
import { ThemeProvider } from './hooks/useTheme';
import { ChatProvider } from './hooks/useChatStore';
import { SidebarChatProvider } from './hooks/useSidebarChat';
import { AuthProvider } from './hooks/useAuth';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DialogProvider } from './components/ConfirmDialog';
import { ToastProvider } from './components/ToastProvider';
import { installPtBrUi } from './i18n/ptBR';

installPtBrUi();

/** Existing owner application, loaded only outside the isolated customer portal. */
export function AdminApp() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <BrowserRouter>
          <AuthProvider>
            <WebSocketProvider>
              <ChatProvider>
                <SidebarChatProvider>
                  <DialogProvider>
                    <ToastProvider>
                      <App />
                    </ToastProvider>
                  </DialogProvider>
                </SidebarChatProvider>
              </ChatProvider>
            </WebSocketProvider>
          </AuthProvider>
        </BrowserRouter>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
