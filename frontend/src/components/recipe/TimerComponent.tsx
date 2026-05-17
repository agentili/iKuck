import React, { useState, useEffect } from 'react';
import { Play, Pause, RotateCcw } from 'lucide-react';

interface TimerComponentProps {
  durationSeconds: number;
  label: string;
}

const TimerComponent: React.FC<TimerComponentProps> = ({ durationSeconds, label }) => {
  const [timeLeft, setTimeLeft] = useState(durationSeconds);
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    let interval: any = null;
    if (isActive && timeLeft > 0) {
      interval = setInterval(() => {
        setTimeLeft((time) => time - 1);
      }, 1000);
    } else if (timeLeft === 0) {
      setIsActive(false);
      // Play sound
      const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
      audio.play().catch(e => console.error('Audio play failed', e));
    }
    return () => clearInterval(interval);
  }, [isActive, timeLeft]);

  const toggle = () => setIsActive(!isActive);
  const reset = () => {
    setTimeLeft(durationSeconds);
    setIsActive(false);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col p-4 bg-emerald-50 rounded-lg border border-emerald-100 items-center">
      <p className="text-xs font-semibold text-emerald-800 uppercase mb-2">{label}</p>
      <div className="text-3xl font-mono font-bold text-primary mb-4">{formatTime(timeLeft)}</div>
      <div className="flex space-x-4">
        <button
          onClick={toggle}
          className="p-2 bg-primary text-white rounded-full hover:bg-emerald-700 transition-colors"
        >
          {isActive ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <button
          onClick={reset}
          className="p-2 bg-white text-gray-400 border border-gray-200 rounded-full hover:text-gray-600 transition-colors"
        >
          <RotateCcw size={20} />
        </button>
      </div>
      {timeLeft === 0 && <p className="mt-2 text-sm font-bold text-emerald-600 animate-bounce">Completato!</p>}
    </div>
  );
};

export default TimerComponent;
