import { Alert, AlertTitle, Button } from '@mui/material';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface PageErrorBoundaryState {
  error: Error | null;
}

/**
 * Keeps a page that throws while it renders to its own place, so the console's
 * title and navigation stay and the operator is told what broke. Without it
 * React unmounts the whole tree and leaves a blank window. The shell keys it by
 * route, so moving to another page starts it clean.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, PageErrorBoundaryState> {
  override state: PageErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): PageErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('A page failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Alert
        severity="error"
        action={
          <Button color="inherit" size="small" onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
      >
        <AlertTitle>This page could not be shown</AlertTitle>
        {error.message} Another page from the navigation still works, and reloading tries this one again.
      </Alert>
    );
  }
}
