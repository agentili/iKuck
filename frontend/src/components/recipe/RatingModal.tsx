import React, { useState } from 'react';
import { Star, X } from 'lucide-react';

interface RatingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (rating: number, notes: string) => void;
}

const RatingModal: React.FC<RatingModalProps> = ({ isOpen, onClose, onSubmit }) => {
  const [rating, setRating] = useState(0);
  const [notes, setNotes] = useState('');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50">
      <div className="w-full max-w-md p-6 bg-white rounded-xl shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-800">Com\'era la cena?</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={24} />
          </button>
        </div>

        <div className="flex justify-center space-x-2 mb-6">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => setRating(star)}
              className="transition-transform active:scale-110"
            >
              <Star
                size={40}
                fill={star <= rating ? '#fbbf24' : 'none'}
                color={star <= rating ? '#fbbf24' : '#d1d5db'}
              />
            </button>
          ))}
        </div>

        <textarea
          placeholder="Aggiungi una nota (es. troppo sale, buonissima...)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full p-3 border rounded-lg focus:ring-primary focus:border-primary h-32 mb-6"
        ></textarea>

        <button
          onClick={() => onSubmit(rating, notes)}
          disabled={rating === 0}
          className="w-full py-3 bg-primary text-white font-bold rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
        >
          Salva e concludi
        </button>
      </div>
    </div>
  );
};

export default RatingModal;
