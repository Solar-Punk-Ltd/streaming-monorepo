import { HashRouter, Navigate, Route, Routes } from 'react-router';

import { AuthProvider } from './auth';
import { useArchive } from './components/archive/ArchiveProvider';
import { RequireAuth } from './components/RequireAuth';
import { SnackbarProvider } from './components/Snackbar';
import { AccessPage } from './pages/AccessPage';
import { ArchivePage } from './pages/ArchivePage';
import { FundingPage } from './pages/FundingPage';
import { LoginPage } from './pages/LoginPage';
import { StagesPage } from './pages/StagesPage';
import { StreamDetailsPage } from './pages/StreamDetailsPage';
import { StreamFormPage } from './pages/StreamFormPage';
import { StreamsPage } from './pages/StreamsPage';

/**
 * The Archive page inside the signed-in shell, whose job providers it reads: "Archive more qualities" and "Archive
 * again" open the archive panel on their stream, and "Copy onto another stamp" opens it in its copy mode.
 */
function ArchiveRoute() {
  const { openPanel } = useArchive();
  return (
    <ArchivePage onArchive={openPanel} onCopy={(streamId, renditions) => openPanel(streamId, renditions, 'copy')} />
  );
}

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
              <Route path="/stages" element={<StagesPage />} />
              <Route path="/funding" element={<FundingPage />} />
              <Route path="/archive" element={<ArchiveRoute />} />
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
