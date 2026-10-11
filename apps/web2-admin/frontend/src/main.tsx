import React from 'react';
import ReactDOM from 'react-dom/client';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';

import { App } from './App';
import { ThemeChoiceProvider } from './theme/ThemeChoiceProvider';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeChoiceProvider>
      {/* One adapter for every picker in the console; the schedule field is
          the only user today, but mounting it here keeps it that way. */}
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <App />
      </LocalizationProvider>
    </ThemeChoiceProvider>
  </React.StrictMode>,
);
