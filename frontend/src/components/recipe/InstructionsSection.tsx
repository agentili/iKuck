import React, { useState } from 'react';
import TimerComponent from './TimerComponent';

interface Instruction {
  step: number;
  description: string;
  duration?: number; // in seconds
}

interface InstructionsSectionProps {
  instructions: Instruction[];
}

const InstructionsSection: React.FC<InstructionsSectionProps> = ({ instructions }) => {
  const [currentStep, setCurrentStep] = useState(0);

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-800">Preparazione</h2>
      <div className="space-y-8">
        {instructions.map((step, index) => (
          <div
            key={index}
            className={`flex space-x-4 transition-opacity ${
              index === currentStep ? 'opacity-100' : 'opacity-40'
            }`}
          >
            <div className="flex-shrink-0">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${
                index === currentStep ? 'bg-primary text-white' : 'bg-gray-200 text-gray-500'
              }`}>
                {step.step}
              </div>
            </div>
            <div className="flex-1 space-y-4">
              <p className="text-gray-700 leading-relaxed">{step.description}</p>
              
              {index === currentStep && step.duration && (
                <TimerComponent durationSeconds={step.duration} label={`Timer Step ${step.step}`} />
              )}

              {index === currentStep && index < instructions.length - 1 && (
                <button
                  onClick={() => setCurrentStep(index + 1)}
                  className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-medium"
                >
                  Step successivo
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default InstructionsSection;
