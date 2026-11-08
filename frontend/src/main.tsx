import ReactDOM from 'react-dom/client';
import AppRoot from './AppRoot';
import './index.css';
import { applyMotionPreference } from './domain/motionPreference';
import { applyColorTheme, watchSystemColorTheme } from './domain/colorTheme';
import { injectCssVariables } from './theme/tokens';
import { applyAccentTheme } from './domain/accentTheme';

applyColorTheme();
watchSystemColorTheme();
applyMotionPreference();
injectCssVariables();
applyAccentTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppRoot />,
);
