import ReactDOM from 'react-dom/client';
import AppRoot from './AppRoot';
import './index.css';
import { applyMotionPreference } from './domain/motionPreference';
import { applyColorTheme, watchSystemColorTheme } from './domain/colorTheme';

applyColorTheme();
watchSystemColorTheme();
applyMotionPreference();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppRoot />,
);
