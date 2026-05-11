import { AppProvider } from './context/AppContext';
import { AppShell } from './components/layout/AppShell';
import './App.css';

export default function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}
