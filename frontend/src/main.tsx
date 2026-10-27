import ReactDOM from 'react-dom/client';
import AppRoot from './AppRoot';
import './index.css';
import './theme-editorial.css';
import { applyColorPalette } from './domain/colorPalette';
import { applyMotionPreference } from './domain/motionPreference';
import { applyColorTheme, watchSystemColorTheme } from './domain/colorTheme';

applyColorPalette();
applyColorTheme();
watchSystemColorTheme();
applyMotionPreference();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppRoot />,
);
