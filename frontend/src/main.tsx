import ReactDOM from 'react-dom/client';
import AppRoot from './AppRoot';
import './index.css';
import { applyMotionPreference } from './domain/motionPreference';

applyMotionPreference();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <AppRoot />,
);
