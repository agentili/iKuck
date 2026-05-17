import React from 'react';
import { useAuthStore } from '../../store/authStore';
import { LogOut } from 'lucide-react';
import { useLocation } from 'react-router-dom';

const Header: React.FC = () => {
  const { logout, user } = useAuthStore();
  const location = useLocation();

  const getTitle = () => {
    switch (location.pathname) {
      case '/pantry': return 'Dispensa';
      case '/suggest': return 'Cosa ceno?';
      case '/history': return 'Storia';
      default: 
        if (location.pathname.startsWith('/recipe/')) return 'Ricetta';
        return 'iRicetto';
    }
  };

  return (
    <header className="bg-primary text-white p-4 flex justify-between items-center shadow-md sticky top-0 z-40">
      <div className="flex items-center space-x-2">
        <span className="font-black text-xl tracking-tighter italic">iR</span>
        <h1 className="font-bold text-lg">{getTitle()}</h1>
      </div>
      <div className="flex items-center space-x-4">
        {user && <span className="text-xs hidden sm:block opacity-80">{user.username}</span>}
        <button
          onClick={logout}
          className="p-2 hover:bg-emerald-700 rounded-full transition-colors"
          title="Esci"
        >
          <LogOut size={20} />
        </button>
      </div>
    </header>
  );
};

export default Header;
