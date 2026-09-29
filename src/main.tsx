import { HouseholdAccess } from './components/HouseholdAccess';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AppUpdate } from './components/AppUpdate';
import { HouseholdProvider } from './store';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HouseholdAccess>
      <HouseholdProvider>
        <App />
        <AppUpdate />
      </HouseholdProvider>
    </HouseholdAccess>
  </React.StrictMode>,
);
