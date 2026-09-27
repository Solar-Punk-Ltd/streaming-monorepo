import { HashRouter, Navigate, Route, Routes } from 'react-router';

import { AuthProvider } from './auth';
import { RequireAuth } from './components/RequireAuth';
import { SnackbarProvider } from './components/Snackbar';
import { AccessPage } from './pages/AccessPage';
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
              <Route path="/access" element={<AccessPage />} />
              {/* The account page folded into Access, which is the one page
                  about logging in. The old hash is kept so a bookmark of it
                  still lands somewhere with a change-password form. */}
              <Route path="/account" element={<Navigate to="/access" replace />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </HashRouter>
    </SnackbarProvider>
  );
}
