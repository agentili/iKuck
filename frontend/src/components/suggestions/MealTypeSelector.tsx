import React from 'react';

interface MealTypeSelectorProps {
  selected: 'breakfast' | 'lunch' | 'dinner';
  onChange: (type: 'breakfast' | 'lunch' | 'dinner') => void;
}

const MealTypeSelector: React.FC<MealTypeSelectorProps> = ({ selected, onChange }) => {
  const types: { id: 'breakfast' | 'lunch' | 'dinner'; label: string }[] = [
    { id: 'breakfast', label: 'Colazione' },
    { id: 'lunch', label: 'Pranzo' },
    { id: 'dinner', label: 'Cena' },
  ];

  return (
    <div className="flex p-1 bg-gray-200 rounded-lg">
      {types.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={`flex-1 py-2 text-sm font-medium rounded-md transition-all ${
            selected === t.id
              ? 'bg-white text-primary shadow-sm'
              : 'text-gray-500 hover:text-gray-700'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
};

export default MealTypeSelector;
