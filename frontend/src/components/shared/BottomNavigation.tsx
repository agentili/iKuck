import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutGrid, Utensils, History } from 'lucide-react';

const BottomNavigation: React.FC = () => {
  const tabs = [
    { path: '/pantry', label: 'Dispensa', icon: LayoutGrid },
    { path: '/suggest', label: 'Cosa ceno?', icon: Utensils },
    { path: '/history', label: 'Storia', icon: History },
  ];

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-4 py-2 flex justify-between items-center z-50">
      {tabs.map((tab) => (
        <NavLink
          key={tab.path}
          to={tab.path}
          className={({ isActive }) =>
            `flex flex-col items-center space-y-1 flex-1 py-1 transition-colors ${
              isActive ? 'text-primary' : 'text-gray-400 hover:text-gray-600'
            }`
          }
        >
          <tab.icon size={24} />
          <span className="text-[10px] font-bold uppercase tracking-wider">{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
};

export default BottomNavigation;
