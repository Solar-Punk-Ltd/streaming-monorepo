import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';

import { AuthProvider } from './auth';
import { RequireAuth } from './components/RequireAuth';
import { SnackbarProvider } from './components/Snackbar';
import { AccountPage } from './pages/AccountPage';
import { LoginPage } from './pages/LoginPage';
import { StreamDetailsPage } from './pages/StreamDetailsPage';
import { StreamFormPage } from './pages/StreamFormPage';
import { StreamsPage } from './pages/StreamsPage';

export function App() {
  return (
    <SnackbarProvider>
      <HashRouter>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route path="/" element={<StreamsPage />} />
              <Route path="/create" element={<StreamFormPage />} />
              <Route path="/edit/:id" element={<StreamFormPage />} />
              <Route path="/streams/:id" element={<StreamDetailsPage />} />
              <Route path="/account" element={<AccountPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </HashRouter>
    </SnackbarProvider>
  );
}
